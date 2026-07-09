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

// ── Screenshot upload + tracking endpoints ───────────────────────────────────

async function callMultipart(app, pathname, { payload, file, fieldName = 'screenshot', type = 'image/png' } = {}) {
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const form = new FormData();
    if (payload !== undefined) form.append('payload', JSON.stringify(payload));
    if (file) form.append(fieldName, new Blob([file], { type }), 'route.png');
    const res = await fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { authorization: 'Bearer x' },
      body: form,
    });
    const json = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
    return { status: res.status, json };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('POST / multipart stores the screenshot and passes the JSON payload through', async () => {
  let assigned = null;
  let savedShot = null;
  const app = loadApp({
    serviceMock: {
      async assignRoute(args) { assigned = args; return { assignment: { id: 9 }, computed: true, geometryPending: false }; },
    },
    rcMock: {
      async saveRouteScreenshot(id, shot) { savedShot = { id, ...shot }; return { file_size_bytes: shot.data.length }; },
    },
  });
  const res = await callMultipart(app, '/api/route-control', {
    payload: {
      groupId: 7, url: 'https://maps.google.com/dir?x=1',
      tracking: { startMode: 'immediate' },
    },
    file: Buffer.from('FAKE-PNG-BYTES'),
  });
  assert.equal(res.status, 200);
  assert.equal(assigned.groupId, 7);
  assert.deepEqual(assigned.tracking, { startMode: 'immediate' });
  assert.equal(savedShot.id, 9);
  assert.equal(savedShot.mimeType, 'image/png');
  assert.equal(savedShot.data.toString(), 'FAKE-PNG-BYTES');
  assert.equal(res.json.screenshot.stored, true);
});

test('POST / multipart rejects a non-image screenshot type', async () => {
  const app = loadApp({ serviceMock: { async assignRoute() { throw new Error('should not be reached'); } } });
  const res = await callMultipart(app, '/api/route-control', {
    payload: { groupId: 7, url: 'https://x' },
    file: Buffer.from('%PDF-1.4'),
    type: 'application/pdf',
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'SCREENSHOT_INVALID');
});

test('POST / plain JSON keeps working and forwards the tracking options', async () => {
  let assigned = null;
  const app = loadApp({
    serviceMock: {
      async assignRoute(args) { assigned = args; return { assignment: { id: 3 }, computed: false, geometryPending: true }; },
    },
  });
  const res = await call(app, 'POST', '/api/route-control', {
    groupId: 4, url: 'https://maps.google.com/dir?x=1',
    tracking: { startMode: 'scheduled_time', startAt: '2026-08-01T15:00:00Z' },
  });
  assert.equal(res.status, 200);
  assert.equal(assigned.groupId, 4);
  assert.equal(assigned.tracking.startMode, 'scheduled_time');
});

test('POST /:id/screenshot uploads a replacement; missing file is a clear 400', async () => {
  let saved = null;
  const app = loadApp({
    rcMock: {
      async getRouteAssignment(id) { return { id }; },
      async saveRouteScreenshot(id, shot) { saved = { id, size: shot.data.length }; return { file_size_bytes: shot.data.length, mime_type: shot.mimeType }; },
    },
  });
  const missing = await call(app, 'POST', '/api/route-control/5/screenshot', {});
  assert.equal(missing.status, 400);
  assert.equal(missing.json.code, 'NO_FILE');

  const ok = await callMultipart(app, '/api/route-control/5/screenshot', { file: Buffer.from('IMG') });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.stored, true);
  assert.equal(saved.id, 5);
});

test('GET /:id/screenshot streams the stored bytes with the right content type', async () => {
  const app = loadApp({
    rcMock: {
      async getRouteScreenshot() { return { mime_type: 'image/webp', file_data: Buffer.from('WEBP-BYTES') }; },
    },
  });
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/route-control/5/screenshot`, { headers: { authorization: 'Bearer x' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/webp');
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'WEBP-BYTES');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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
