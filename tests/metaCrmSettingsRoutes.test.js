'use strict';

/**
 * /api/settings/meta-crm over HTTP: every route behind the admin gate, the
 * Test rate-limited (it calls Meta and Bitrix), a refused save a 400 with the
 * check that refused it, and the token in no response and no log line.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createMetaCrmSettingsRouter } = require('../server/routes/settings/metaCrmRoutes');
const { createRateLimiter } = require('../server/middleware/rateLimit');

const TOKEN = 'EAAG-route-test-token-000000000';

function serve(t, { signedIn = true, service = {}, testLimiter = null } = {}) {
  const app = express();
  app.use(express.json());
  const authMiddleware = (req, res, next) => {
    if (!signedIn) return res.status(401).json({ error: 'sign in' });
    req.admin = { id: 7, username: 'owner' };
    return next();
  };
  const settingsService = {
    getSettingsView: async () => ({ enabled: true, datasetId: '111', tokenMasked: '••••0000' }),
    testSettings: async () => ({ passed: true, checks: [] }),
    saveSettings: async (body, { by }) => ({ datasetId: body.datasetId, savedBy: by }),
    setEnabled: async (enabled) => ({ enabled }),
    ...service,
  };
  app.use('/api/settings', createMetaCrmSettingsRouter({ authMiddleware, settingsService, testLimiter }));
  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/settings/meta-crm`;
}

const send = (url, method, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });

test('every route needs a signed-in admin', async (t) => {
  const base = serve(t, { signedIn: false });
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await send(`${base}/test`, 'POST', { datasetId: '1', token: TOKEN })).status, 401);
  assert.equal((await send(base, 'PUT', { datasetId: '1', token: TOKEN })).status, 401);
  assert.equal((await send(`${base}/enabled`, 'PUT', { enabled: false })).status, 401);
});

test('a save records who saved it; the switch takes a body', async (t) => {
  const base = serve(t);
  assert.deepEqual(await (await send(base, 'PUT', { datasetId: '222', token: TOKEN })).json(), { settings: { datasetId: '222', savedBy: 'owner' } });
  assert.deepEqual(await (await send(`${base}/enabled`, 'PUT', { enabled: false })).json(), { settings: { enabled: false } });
});

test('a refused save is a 400 carrying the check that refused it', async (t) => {
  const base = serve(t, {
    service: {
      saveSettings: async () => {
        const err = new Error('Not saved: Meta does not accept this access token.');
        err.statusCode = 400;
        err.check = { key: 'token', status: 'fail' };
        throw err;
      },
    },
  });
  const res = await send(base, 'PUT', { datasetId: '222', token: TOKEN });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Not saved: Meta does not accept this access token.', check: { key: 'token', status: 'fail' } });
});

test('Test is rate-limited per admin, with a plain answer and Retry-After', async (t) => {
  const testLimiter = createRateLimiter({ windowMs: 60_000, max: 2, message: 'Too many tests' });
  const base = serve(t, { testLimiter });
  assert.equal((await send(`${base}/test`, 'POST', { datasetId: '1' })).status, 200);
  assert.equal((await send(`${base}/test`, 'POST', { datasetId: '1' })).status, 200);
  const third = await send(`${base}/test`, 'POST', { datasetId: '1' });
  assert.equal(third.status, 429);
  assert.ok(Number(third.headers.get('retry-after')) > 0);
  assert.equal((await third.json()).error, 'Too many tests');
});

test('an unexpected failure is a 500 that names nothing, and the log line has the token taken out', async (t) => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  t.after(() => { console.error = original; });
  const base = serve(t, { service: { testSettings: async () => { throw new Error(`socket hang up while sending ${TOKEN}`); } } });
  const res = await send(`${base}/test`, 'POST', { datasetId: '1', token: TOKEN });
  assert.equal(res.status, 500);
  assert.ok(!JSON.stringify(await res.json()).includes(TOKEN));
  assert.ok(logged.length > 0);
  assert.ok(logged.every((line) => !line.includes(TOKEN)));
});
