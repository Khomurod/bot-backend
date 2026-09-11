/**
 * Operations → Retention, on what the API deliberately cannot do.
 *
 * The list is read-only about the driver. There is no endpoint that records an
 * opinion of one, no note field, and no action that touches their employment —
 * because a screen with any of those becomes, within a month, a performance
 * file nobody agreed to. This file is where that stays true.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const ROUTE = path.resolve(__dirname, '../server/routes/operations/retentionRoutes.js');
const STORE = path.resolve(__dirname, '../database/retentionAssessments.js');

const ROW = {
  id: 3, personId: 11, groupId: 7, driverName: 'Sam Rivera',
  score: 10, level: 'urgent',
  signals: [{ key: 'road_clock_over', detail: '3 weeks past the road allowance' }],
  actions: ['Get them home — they are past the allowance'],
  acknowledgedAt: null,
};

function loadApp({ rows = [ROW], acknowledged = ROW } = {}) {
  delete require.cache[require.resolve(ROUTE)];
  const saw = { listed: [], acked: [] };

  require.cache[STORE] = {
    exports: {
      async listAssessments(args) { saw.listed.push(args); return rows; },
      async summariseRetention() { return { urgent: 1, watch: 2, acknowledged: 0 }; },
      async acknowledge(id, by) { saw.acked.push({ id, by }); return acknowledged; },
    },
  };

  const { createRetentionRouter } = require(ROUTE);
  const app = express();
  app.use(express.json());
  app.use('/api/operations', createRetentionRouter({
    authMiddleware: (req, _res, next) => { req.admin = { username: 'boss' }; next(); },
  }));
  return { app, saw };
}

async function call(app, method, url, body) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { server.close(); }
}

test('the list carries the REASONS and the suggested actions, not just a score', async () => {
  const { app } = loadApp();
  const res = await call(app, 'GET', '/api/operations/retention');
  assert.equal(res.status, 200);
  assert.equal(res.body.assessments[0].signals[0].detail, '3 weeks past the road allowance');
  assert.ok(res.body.assessments[0].actions.length > 0, 'something a person can DO');
  assert.equal(res.body.summary.urgent, 1);
});

test('the list can be narrowed to one level', async () => {
  const { app, saw } = loadApp();
  await call(app, 'GET', '/api/operations/retention?level=urgent&limit=10');
  assert.deepEqual(saw.listed[0], { level: 'urgent', limit: 10 });
});

test('acknowledging records WHO said they knew', async () => {
  const { app, saw } = loadApp();
  const res = await call(app, 'POST', '/api/operations/retention/3/acknowledge', {});
  assert.equal(res.status, 200);
  assert.deepEqual(saw.acked[0], { id: 3, by: 'boss' });
});

test('an acknowledgement can be taken back', async () => {
  const { app, saw } = loadApp();
  await call(app, 'POST', '/api/operations/retention/3/acknowledge', { acknowledged: false });
  assert.equal(saw.acked[0].by, null, 'null clears it rather than recording a second name');
});

test('a nonsense id is refused rather than passed to SQL', async () => {
  const { app, saw } = loadApp();
  for (const id of ['abc', '0', '-1']) {
    const res = await call(app, 'POST', `/api/operations/retention/${id}/acknowledge`, {});
    assert.equal(res.status, 400, id);
  }
  assert.deepEqual(saw.acked, []);
});

test('an id that does not exist is a 404, not a silent success', async () => {
  const { app } = loadApp({ acknowledged: null });
  const res = await call(app, 'POST', '/api/operations/retention/999/acknowledge', {});
  assert.equal(res.status, 404);
});

test('THERE IS NO ENDPOINT THAT RECORDS AN OPINION OF A DRIVER', () => {
  // Read as text, because the property is about what the file does NOT contain.
  const src = require('node:fs').readFileSync(ROUTE, 'utf8');
  const routes = [...src.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.deepEqual(routes.sort(), [
    'GET /retention',
    'POST /retention/:id/acknowledge',
  ], 'two endpoints: read the list, and say you know about one');

  for (const word of ['note', 'rating', 'score:', 'dismiss', 'terminate', 'flagBy']) {
    assert.ok(!src.includes(`req.body?.${word}`), `no field for "${word}"`);
  }
});
