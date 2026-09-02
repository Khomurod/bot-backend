/**
 * Route tests for the Route Control admin API — assignment, driver-group
 * messaging, tracking and completion checks.
 *
 * The service + DB layers are stubbed; these assert the HTTP wiring, the auth
 * gate, and the PARTIAL-SUCCESS behaviour that matters most here: a failed
 * Telegram send must never fail or roll back the assignment, because the route
 * is already assigned and monitoring server-side. The caller gets the assignment
 * plus an explicit send error, not a 500.
 *
 * Screenshot upload, replacement, deletion and edit-in-place live in
 * routeControlScreenshotRoutes.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadApp, call } = require('./helpers/routeControlRouteHarness');

test('POST /:id/send-driver-message sends and returns the result', async () => {
  let received = null;
  const app = loadApp({
    serviceMock: {
      async sendDriverGroupRouteMessage(args) {
        received = args;
        return { sent: true, messageId: 42, sentAt: 'now', mentionConfidence: 'high' };
      },
    },
  });
  const res = await call(app, 'POST', '/api/route-control/5/send-driver-message', {});
  assert.equal(res.status, 200);
  assert.equal(res.json.sent, true);
  assert.equal(res.json.messageId, 42);
  assert.equal(received.assignmentId, 5);
  assert.equal(received.sentBy, 'admin');
});

test('POST /:id/send-driver-message surfaces a clear error + code on failure', async () => {
  const app = loadApp({
    serviceMock: {
      async sendDriverGroupRouteMessage() {
        const e = new Error('This driver group has no Telegram chat id, so the route message cannot be sent.');
        e.code = 'NO_TELEGRAM_GROUP'; e.status = 400; throw e;
      },
    },
  });
  const res = await call(app, 'POST', '/api/route-control/5/send-driver-message', {});
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'NO_TELEGRAM_GROUP');
  assert.match(res.json.error, /no Telegram chat id/);
});

test('POST / with sendToDriverGroup assigns AND sends (full success)', async () => {
  let sendArgs = null;
  const app = loadApp({
    serviceMock: {
      async assignRoute() { return { assignment: { id: 9 }, computed: true, geometryPending: false }; },
      async sendDriverGroupRouteMessage(a) { sendArgs = a; return { sent: true, messageId: 7 }; },
    },
  });
  const res = await call(app, 'POST', '/api/route-control', { groupId: 7, url: 'u', sendToDriverGroup: true });
  assert.equal(res.status, 200);
  assert.equal(res.json.assignment.id, 9);
  assert.equal(res.json.driverMessage.sent, true);
  assert.equal(sendArgs.assignmentId, 9);
});

test('POST / returns partial success when assign succeeds but send fails (no rollback)', async () => {
  const app = loadApp({
    serviceMock: {
      async assignRoute() { return { assignment: { id: 9 }, computed: true, geometryPending: false }; },
      async sendDriverGroupRouteMessage() {
        const e = new Error('Telegram down'); e.code = 'SEND_ERROR'; throw e;
      },
    },
  });
  const res = await call(app, 'POST', '/api/route-control', { groupId: 7, url: 'u', sendToDriverGroup: true });
  assert.equal(res.status, 200); // assignment still succeeded
  assert.equal(res.json.assignment.id, 9);
  assert.equal(res.json.driverMessage.sent, false);
  assert.match(res.json.driverMessage.error, /Telegram down/);
});

test('POST / does NOT send when sendToDriverGroup is falsy', async () => {
  let sendCalled = false;
  const app = loadApp({
    serviceMock: {
      async assignRoute() { return { assignment: { id: 9 }, computed: true, geometryPending: false }; },
      async sendDriverGroupRouteMessage() { sendCalled = true; return { sent: true }; },
    },
  });
  const res = await call(app, 'POST', '/api/route-control', { groupId: 7, url: 'u' });
  assert.equal(res.status, 200);
  assert.equal(sendCalled, false);
  assert.equal(res.json.driverMessage, undefined);
});

test('send-driver-message is behind auth (401 without a token)', async () => {
  const app = loadApp({ auth: false, serviceMock: { async sendDriverGroupRouteMessage() { return { sent: true }; } } });
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/route-control/5/send-driver-message`, { method: 'POST' });
    assert.equal(res.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


// ── Completion-check and tracking endpoints ──────────────────────────────────

test('POST /:id/run-completion-check wires through to the service', async () => {
  let received = null;
  const app = loadApp({
    serviceMock: {
      async runCompletionCheckNow(args) {
        received = args;
        return {
          alreadyRunning: false, completionRadiusMiles: 35,
          results: [{ id: 5, completed: true, distanceMiles: 31.8 }],
        };
      },
    },
  });
  const res = await call(app, 'POST', '/api/route-control/5/run-completion-check', {});
  assert.equal(res.status, 200);
  assert.equal(received.assignmentId, 5);
  assert.equal(res.json.completionRadiusMiles, 35);
  assert.equal(res.json.results[0].completed, true);
});

test('POST /run-completion-check reconciles all active routes', async () => {
  let calledWith = 'unset';
  const app = loadApp({
    serviceMock: {
      async runCompletionCheckNow(args) {
        calledWith = args;
        return { alreadyRunning: false, completionRadiusMiles: 35, results: [] };
      },
    },
  });
  const res = await call(app, 'POST', '/api/route-control/run-completion-check', {});
  assert.equal(res.status, 200);
  assert.equal(calledWith, undefined, 'no assignment scope — all active routes');
});


test('POST /:id/start-tracking wires through to the service', async () => {
  let started = null;
  const app = loadApp({
    serviceMock: {
      async startTrackingNow(id, by) { started = { id, by }; return { alreadyActive: false, assignment: { id, tracking_status: 'active' } }; },
    },
  });
  const res = await call(app, 'POST', '/api/route-control/8/start-tracking', {});
  assert.equal(res.status, 200);
  assert.equal(res.json.alreadyActive, false);
  assert.deepEqual(started, { id: 8, by: 'admin' });
});
