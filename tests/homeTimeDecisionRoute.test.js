/**
 * POST /api/home-time/requests/:id/decision — RETIRED.
 *
 * This endpoint ran the approve/decline workflow behind the admin panel's
 * Approve / Do Not Approve buttons. Home Time no longer asks permission: a
 * completed stay is `recorded` and three managers are told. The buttons are
 * gone from the admin panel, and this file is what stops the workflow coming
 * back through an admin tab that was open before the deploy, a bookmark, or a
 * script someone wrote against it.
 *
 * It answers 410 Gone and calls NOTHING. The historical `approved` / `denied`
 * rows are untouched and still read by the efficiency report — retiring the
 * decision is not the same as erasing the decisions already taken.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function loadApp() {
  const routePath = require.resolve('../server/routes/homeTimeDecisionRoutes');
  const svcPath = require.resolve('../services/homeTimeRequestService');
  for (const p of [routePath, svcPath]) delete require.cache[p];

  const calls = [];
  // If the route still reaches the workflow, this records it and the test fails.
  require.cache[svcPath] = {
    exports: {
      async applyHomeTimeDecision(...args) { calls.push(args); return { ok: true, request: {} }; },
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
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { server.close(); }
}

test('an approve is refused with 410 and changes nothing', async () => {
  const { app, calls } = loadApp();
  const res = await post(app, '/api/home-time/requests/5/decision', { decision: 'approve' });
  assert.equal(res.status, 410);
  assert.equal(calls.length, 0, 'the retired workflow must not run');
  assert.match(res.body.error, /no longer/i);
  assert.equal(res.body.code, 'approval_retired');
});

test('a decline is refused the same way — neither direction survives', async () => {
  const { app, calls } = loadApp();
  const res = await post(app, '/api/home-time/requests/5/decision', { decision: 'decline' });
  assert.equal(res.status, 410);
  assert.equal(calls.length, 0);
});

test('the reply says what to do instead, so a stale tab is not a dead end', async () => {
  const { app } = loadApp();
  const res = await post(app, '/api/home-time/requests/5/decision', { decision: 'approve' });
  assert.match(JSON.stringify(res.body), /recorded|managers/i,
    'an operator reading this must learn what replaced the decision');
});

test('a nonsense id is still refused, not treated as a special case', async () => {
  const { app, calls } = loadApp();
  const res = await post(app, '/api/home-time/requests/abc/decision', { decision: 'approve' });
  assert.equal(res.status, 410);
  assert.equal(calls.length, 0);
});
