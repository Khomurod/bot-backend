/**
 * Route tests for POST /api/home-time/requests/:id/decision — the admin-panel
 * approve/decline endpoint. The shared service is mocked so these assert the HTTP
 * contract: admin identity passthrough, decision passthrough, and the mapping of
 * every typed result code to the right status code.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function loadApp({ result }) {
  const routePath = require.resolve('../server/routes/homeTimeDecisionRoutes');
  const svcPath = require.resolve('../services/homeTimeRequestService');
  for (const p of [routePath, svcPath]) delete require.cache[p];

  const calls = [];
  require.cache[svcPath] = {
    exports: {
      async applyHomeTimeDecision(telegram, id, opts) {
        calls.push({ telegram, id, opts });
        return result;
      },
    },
  };

  const { registerHomeTimeDecisionRoutes } = require(routePath);
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerHomeTimeDecisionRoutes(router, {
    authMiddleware: (req, _res, next) => { req.admin = { username: 'boss' }; next(); },
    resolveTelegramFn: () => null,
  });
  app.use('/api/home-time', router);
  return { app, calls };
}

async function post(app, pathname, body) {
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
    return { status: res.status, json };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('approve → 200 and passes admin username + via:admin to the shared workflow', async () => {
  const decided = { id: 5, status: 'approved', decided_by_username: 'boss' };
  const { app, calls } = loadApp({ result: { ok: true, request: decided } });
  const res = await post(app, '/api/home-time/requests/5/decision', { decision: 'approve' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.request, decided);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 5);
  assert.equal(calls[0].opts.decision, 'approve');
  assert.equal(calls[0].opts.decidedByUsername, 'boss');
  assert.equal(calls[0].opts.via, 'admin');
});

test('decline → 200', async () => {
  const { app } = loadApp({ result: { ok: true, request: { id: 5, status: 'denied' } } });
  const res = await post(app, '/api/home-time/requests/5/decision', { decision: 'decline' });
  assert.equal(res.status, 200);
  assert.equal(res.json.request.status, 'denied');
});

test('not found → 404', async () => {
  const { app } = loadApp({ result: { ok: false, code: 'not_found' } });
  const res = await post(app, '/api/home-time/requests/5/decision', { decision: 'approve' });
  assert.equal(res.status, 404);
  assert.equal(res.json.code, 'not_found');
});

test('invalid dates → 422', async () => {
  const { app } = loadApp({ result: { ok: false, code: 'invalid_dates', request: { id: 5, status: 'pending' } } });
  const res = await post(app, '/api/home-time/requests/5/decision', { decision: 'approve' });
  assert.equal(res.status, 422);
  assert.match(res.json.error, /date/i);
});

test('already decided → 409 with the final status', async () => {
  const { app } = loadApp({ result: { ok: false, code: 'already_decided', request: { id: 5, status: 'approved' } } });
  const res = await post(app, '/api/home-time/requests/5/decision', { decision: 'approve' });
  assert.equal(res.status, 409);
  assert.match(res.json.error, /already approved/i);
});

test('conflict (concurrent decision) → 409', async () => {
  const { app } = loadApp({ result: { ok: false, code: 'conflict', request: { id: 5, status: 'denied' } } });
  const res = await post(app, '/api/home-time/requests/5/decision', { decision: 'approve' });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'conflict');
});

test('invalid request id → 400 and never calls the service', async () => {
  const { app, calls } = loadApp({ result: { ok: true, request: {} } });
  const res = await post(app, '/api/home-time/requests/0/decision', { decision: 'approve' });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('invalid decision → 400 (surfaced from the shared workflow)', async () => {
  const { app } = loadApp({ result: { ok: false, code: 'invalid_decision' } });
  const res = await post(app, '/api/home-time/requests/5/decision', { decision: 'maybe' });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'invalid_decision');
});
