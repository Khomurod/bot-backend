/**
 * PUT /api/groups/:groupId/samsara-driver-alerts — the switch behind Driver
 * Groups → driver details → "Samsara alerts in this group".
 *
 * Guarded here, with the data layer injected (no database):
 *   • only a real boolean is accepted — the string "false" is truthy, and
 *     reading it as ON would keep posting to a group somebody switched off;
 *   • the GROUP id is what is written, and the answer is what was saved;
 *   • a missing group is 404, a chat that is not a driver group is 409;
 *   • every change leaves an audit row with the value it replaced, and an
 *     audit failure never turns a saved switch into an error;
 *   • the answer, and the status read, say whether the RUNNING Samsara
 *     service honours the switch yet — the screen must never claim Off is
 *     applied while an older build is still posting.
 */
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-secret';
process.env.BOT_TOKEN ||= '123:test-bot-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createDriverGroupsRoutes } = require('../server/routes/driverGroupsRoutes');

function loadApp({ result = null, throws = null, auditThrows = false, enforced = true } = {}) {
  const calls = [];
  const audits = [];
  const samsaraAlerts = {
    async setSamsaraDriverAlertsEnabled(groupId, enabled) {
      calls.push({ groupId, enabled });
      if (throws) throw throws;
      return result || { status: 'ok', groupId, groupName: 'Unit 101', previous: !enabled, enabled };
    },
    async getSamsaraSwitchEnforcement() {
      return { enforced, lastBeatAt: enforced ? '2026-11-03T15:00:00.000Z' : null };
    },
  };
  const insertAdminAudit = async (entry) => {
    if (auditThrows) throw new Error('audit table unavailable');
    audits.push(entry);
  };
  const app = express();
  app.use(express.json());
  app.use(createDriverGroupsRoutes({
    db: {},
    authMiddleware: (req, _res, next) => { req.admin = { id: 7, username: 'hr', roleKeys: ['super_admin'] }; next(); },
    samsaraAlerts,
    insertAdminAudit,
  }));
  return { app, calls, audits };
}

async function get(app, pathname) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

async function put(app, pathname, body) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('switching OFF writes false for that group, answers with what was saved, and audits the old value', async () => {
  const { app, calls, audits } = loadApp();
  const res = await put(app, '/api/groups/501/samsara-driver-alerts', { enabled: false });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { group_id: 501, samsara_driver_alerts_enabled: false, enforced: true });
  assert.deepEqual(calls, [{ groupId: 501, enabled: false }]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'samsara_driver_alerts.update');
  assert.equal(audits[0].entityType, 'group');
  assert.equal(audits[0].entityId, '501');
  assert.equal(audits[0].adminId, 7);
  assert.deepEqual(audits[0].oldValues, { samsara_driver_alerts_enabled: true });
  assert.deepEqual(audits[0].newValues, { samsara_driver_alerts_enabled: false });
});

test('switching back ON writes true', async () => {
  const { app, calls } = loadApp();
  const res = await put(app, '/api/groups/501/samsara-driver-alerts', { enabled: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.samsara_driver_alerts_enabled, true);
  assert.deepEqual(calls, [{ groupId: 501, enabled: true }]);
});

test('anything but a real boolean is refused, and nothing is written', async () => {
  const { app, calls } = loadApp();
  for (const enabled of ['false', 'true', 0, 1, null, undefined]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await put(app, '/api/groups/501/samsara-driver-alerts', { enabled });
    assert.equal(res.status, 400, `enabled=${JSON.stringify(enabled)}`);
  }
  assert.equal(calls.length, 0);
});

test('a bad group id is refused before anything is written', async () => {
  const { app, calls } = loadApp();
  for (const id of ['0', '-3', 'abc', '1.5']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await put(app, `/api/groups/${id}/samsara-driver-alerts`, { enabled: false });
    assert.equal(res.status, 400, id);
  }
  assert.equal(calls.length, 0);
});

test('a missing group is 404 and a non-driver chat is 409, with no audit row', async () => {
  const missing = loadApp({ result: { status: 'not_found' } });
  assert.equal((await put(missing.app, '/api/groups/9/samsara-driver-alerts', { enabled: false })).status, 404);
  assert.equal(missing.audits.length, 0);

  const company = loadApp({ result: { status: 'not_driver', groupType: 'employee' } });
  const res = await put(company.app, '/api/groups/9/samsara-driver-alerts', { enabled: false });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /only ever posted to driver groups/);
  assert.equal(company.audits.length, 0);
});

test('a database failure is a 500 with no detail', async () => {
  const { app } = loadApp({ throws: new Error('connection refused at 10.0.0.5') });
  const res = await put(app, '/api/groups/501/samsara-driver-alerts', { enabled: false });
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Server error' });
});

test('an audit failure does not turn a saved switch into an error', async () => {
  const { app, calls } = loadApp({ auditThrows: true });
  const res = await put(app, '/api/groups/501/samsara-driver-alerts', { enabled: false });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
});

test('the answer says when the running Samsara service does not honour the switch yet', async () => {
  const { app, calls } = loadApp({ enforced: false });
  const res = await put(app, '/api/groups/501/samsara-driver-alerts', { enabled: false });
  assert.equal(res.status, 200, 'the setting is still saved');
  assert.equal(calls.length, 1);
  assert.equal(res.body.enforced, false);
});

test('the status read reports what the Samsara service last said about itself', async () => {
  const yes = await get(loadApp({ enforced: true }).app, '/api/groups/samsara-driver-alerts/status');
  assert.deepEqual(yes, { status: 200, body: { enforced: true, last_beat_at: '2026-11-03T15:00:00.000Z' } });
  const no = await get(loadApp({ enforced: false }).app, '/api/groups/samsara-driver-alerts/status');
  assert.deepEqual(no, { status: 200, body: { enforced: false, last_beat_at: null } });
});
