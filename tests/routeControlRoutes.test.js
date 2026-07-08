/**
 * Route tests for the Route Control admin API — the new driver-group messaging:
 *   POST /:id/send-driver-message  and  POST / with sendToDriverGroup.
 * The service + DB layers are stubbed; we assert the HTTP wiring, auth gate,
 * partial-success behavior, and that failures never fail the assignment.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

function loadApp({ serviceMock = {}, rcMock = {}, telegram = { sendMessage() {} }, auth = true } = {}) {
  const routePath = path.resolve(__dirname, '../server/routes/routeControlRoutes.js');
  const servicePath = path.resolve(__dirname, '../services/routeControlService.js');
  const rcPath = path.resolve(__dirname, '../database/routeControl.js');
  for (const p of [routePath, servicePath, rcPath]) delete require.cache[p];
  require.cache[servicePath] = { exports: serviceMock };
  require.cache[rcPath] = { exports: rcMock };

  const { createRouteControlRouter } = require(routePath);
  const app = express();
  app.use(express.json());
  const authMiddleware = auth
    ? (req, _res, next) => { req.admin = { username: 'admin' }; next(); }
    : (req, res, next) => {
      if (!req.headers.authorization) return res.status(401).json({ error: 'Unauthorized' });
      req.admin = { username: 'admin' }; return next();
    };
  app.use('/api/route-control', createRouteControlRouter({ authMiddleware, telegram }));
  return app;
}

async function call(app, method, pathname, body) {
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
    return { status: res.status, json };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

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
