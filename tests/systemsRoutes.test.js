'use strict';

/**
 * Admin → Operations → What is running, on the one field it did not carry.
 *
 * FOUND IN PRODUCTION, not in review. `return_to_road` reached
 * `repeatedly_failing` and every surface said the same thing about it: "3
 * consecutive failures". True, and impossible to act on. The message was in
 * `background_service_runs.last_error` the whole time and reached no screen, so
 * a critical worker could be known to be broken and not diagnosable without
 * shell access to the server logs.
 *
 * THE SPLIT THAT MATTERS. This route is behind `authMiddleware`; `/api/health`
 * is public and read by Render and an uptime monitor. An `err.message` can
 * quote a value a database rejected, so the message travels HERE and nowhere
 * else — the health endpoint keeps its counts and its short reasons.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const ROUTE = path.resolve(__dirname, '../server/routes/operations/systemsRoutes.js');
const OBS = path.resolve(__dirname, '../services/operations/healthObservations.js');
const RUNS = path.resolve(__dirname, '../database/backgroundRuns.js');

function loadApp({ observed = [], ledger = [] } = {}) {
  delete require.cache[require.resolve(ROUTE)];
  require.cache[OBS] = { exports: { async gatherAllObservations() { return observed; } } };
  require.cache[RUNS] = { exports: { async listRuns() { return ledger; } } };

  const { createSystemsRouter } = require(ROUTE);
  const app = express();
  app.use(express.json());
  app.use('/api/operations', createSystemsRouter({
    authMiddleware: (req, _res, next) => { req.admin = { username: 'admin' }; next(); },
  }));
  return app;
}

async function get(app, url) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { server.close(); }
}

const OBSERVED = {
  component: 'return_to_road', label: 'return to road', group: 'engine',
  critical: true, state: 'repeatedly_failing', reason: '3 consecutive failures',
};

test('a failing component carries the error that was recorded for it', async () => {
  const app = loadApp({
    observed: [OBSERVED],
    ledger: [{
      serviceKey: 'return_to_road', lastError: 'connect ETIMEDOUT',
      lastErrorAt: '2026-09-11T10:47:44.745Z', consecutiveFailures: 3,
      lastFinishedAt: '2026-09-11T10:47:44.745Z', runsTotal: 40,
    }],
  });
  const res = await get(app, '/api/operations/systems');
  assert.equal(res.status, 200);
  const row = res.body.components.find((c) => c.component === 'return_to_road');
  assert.equal(row.lastError, 'connect ETIMEDOUT',
    'the reason names the symptom; without this nothing names the cause');
  assert.equal(row.lastErrorAt, '2026-09-11T10:47:44.745Z');
  assert.equal(row.consecutiveFailures, 3);
});

test('a component with no ledger row reports no error rather than undefined', async () => {
  const app = loadApp({ observed: [{ ...OBSERVED, state: 'cannot_determine' }] });
  const res = await get(app, '/api/operations/systems');
  const row = res.body.components[0];
  assert.equal(row.lastError, null);
  assert.equal(row.lastErrorAt, null);
});

test('a healthy component that once failed still carries its last error', async () => {
  // Deliberate: "it recovered" is worth knowing WITH what it recovered from,
  // and `lastErrorAt` beside `lastOkAt` is what tells a reader which came last.
  const app = loadApp({
    observed: [{ ...OBSERVED, state: 'healthy', reason: 'ran' }],
    ledger: [{
      serviceKey: 'return_to_road', lastError: 'connect ETIMEDOUT',
      lastErrorAt: '2026-09-11T09:00:00.000Z', lastOkAt: '2026-09-11T10:00:00.000Z',
      consecutiveFailures: 0, runsTotal: 41,
    }],
  });
  const res = await get(app, '/api/operations/systems');
  const row = res.body.components[0];
  assert.equal(row.lastError, 'connect ETIMEDOUT');
  assert.ok(row.lastOkAt > row.lastErrorAt, 'and the timestamps say it is behind us');
});
