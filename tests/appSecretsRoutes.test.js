'use strict';

/**
 * /api/settings/app-secrets over HTTP: super administrators only (by role),
 * the restart happens only when this app's own values changed, the audit
 * holds names and never a value, and an error says nothing it should not.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createAppSecretsRouter } = require('../server/routes/settings/appSecretsRoutes');

const SECRET = '999999:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZ';

function serve(t, { roles = ['super_admin'], service = {}, audits = [], restarts = [] } = {}) {
  const app = express();
  app.use(express.json());
  const authMiddleware = (req, res, next) => {
    req.admin = { id: 1, username: 'owner', role_keys: roles };
    next();
  };
  const preview = (over = {}) => ({
    target: 'bot', baseVersion: 1, added: [{ scope: 'both', name: 'BOT_TOKEN' }], changed: [], removed: [],
    unchanged: 0, skipped: [], duplicates: [], tokens: [], blocking: [], warnings: [], canSave: true,
    restartsThisApp: true, ...over,
  });
  const secretsService = {
    getView: async () => ({ keyConfigured: true, values: [] }),
    preview: async () => preview(),
    save: async () => ({ versionId: 2, preview: preview() }),
    removeValue: async () => ({ versionId: 3, restartsThisApp: false }),
    restore: async () => ({ versionId: 4, restoredFrom: 1 }),
    ...service,
  };
  app.use('/api/settings', createAppSecretsRouter({
    authMiddleware,
    secretsService,
    insertAdminAudit: async (row) => { audits.push(row); },
    restart: () => restarts.push(true),
    previewLimiter: (req, res, next) => next(),
  }));
  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/settings/app-secrets`;
}

const send = (url, method, body) => fetch(url, {
  method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
});

test('everyone but a super administrator is refused, on every route', async (t) => {
  const base = serve(t, { roles: ['admin'] });
  assert.equal((await fetch(base)).status, 403);
  assert.equal((await send(`${base}/preview`, 'POST', { target: 'bot', text: 'A=1' })).status, 403);
  assert.equal((await send(base, 'PUT', { target: 'bot', text: 'A=1' })).status, 403);
  assert.equal((await send(`${base}/bot/A`, 'DELETE')).status, 403);
  assert.equal((await send(`${base}/versions/1/restore`, 'POST')).status, 403);
});

test('a save is audited by name, and restarts the app when its own values changed', async (t) => {
  const audits = [];
  const restarts = [];
  const base = serve(t, { audits, restarts });
  const res = await send(base, 'PUT', { target: 'bot', text: `BOT_TOKEN=${SECRET}`, baseVersion: 1 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.restarting, true);
  assert.equal(restarts.length, 1);
  assert.equal(audits[0].action, 'app_secrets.save');
  assert.deepEqual(audits[0].newValues.added, ['both:BOT_TOKEN']);
  assert.ok(!JSON.stringify(audits).includes(SECRET));
  assert.ok(!JSON.stringify(body).includes(SECRET));
});

test('a change only the Samsara service reads does not restart this app', async (t) => {
  const restarts = [];
  const base = serve(t, { restarts });
  const res = await send(`${base}/samsara/HARDCODED_GROUP_ID`, 'DELETE');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { versionId: 3, restarting: false });
  assert.equal(restarts.length, 0);
});

test('a restore always restarts; a bad version number is a 400', async (t) => {
  const restarts = [];
  const base = serve(t, { restarts });
  assert.equal((await send(`${base}/versions/abc/restore`, 'POST')).status, 400);
  const res = await send(`${base}/versions/1/restore`, 'POST');
  assert.deepEqual(await res.json(), { versionId: 4, restoredFrom: 1, restarting: true });
  assert.equal(restarts.length, 1);
});

test('a refused save is a 400 with the preview; an unexpected error is a plain 500', async (t) => {
  const base = serve(t, {
    service: {
      save: async () => { throw Object.assign(new Error('JWT_SECRET is missing'), { statusCode: 400, preview: { blocking: ['x'] } }); },
      getView: async () => { throw new Error(`boom ${SECRET}`); },
    },
  });
  const refused = await send(base, 'PUT', { target: 'bot', text: 'A=1' });
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: 'JWT_SECRET is missing', preview: { blocking: ['x'] } });
  const broken = await fetch(base);
  assert.equal(broken.status, 500);
  assert.ok(!(await broken.text()).includes(SECRET));
});

test('a preview never carries the internal plan, even if the service handed it over', async (t) => {
  const base = serve(t, {
    service: { preview: async () => ({ target: 'bot', added: [], _plan: { items: [{ name: 'BOT_TOKEN', value: SECRET }] } }) },
  });
  const res = await send(`${base}/preview`, 'POST', { target: 'bot', text: 'A=1' });
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes(SECRET));
  assert.ok(!text.includes('_plan'));
});
