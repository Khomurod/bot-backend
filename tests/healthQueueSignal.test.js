/**
 * /api/health reports a durable queue that has given up.
 *
 * A `failed` outbox row is the queue behaving correctly — retried, backed off,
 * stopped — and simultaneously the only record that a destination is unreachable.
 * Production held 101 of them for months with nothing to show for it.
 *
 * The load-bearing assertion here is the negative one: this signal must never
 * change the status code. Render and the uptime monitor read that, and an alert
 * queue nobody can deliver to is an operator's problem, not a reason to declare
 * the service down and cycle it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const HEALTH_PATH = path.resolve(__dirname, '../server/routes/healthRoutes.js');

function loadApp({ dbOk = true, exhausted, injectCounter = true }) {
  // The counter is a constructor dependency, so no module surgery is needed —
  // which is the point: healthRoutes must stand up with no database behind it.
  delete require.cache[HEALTH_PATH];
  const { createHealthRoutes } = require(HEALTH_PATH);

  const app = express();
  app.use(createHealthRoutes({
    db: { async ping() { return dbOk; } },
    config: { metaAppId: null, metaAppSecret: null },
    countExhaustedInternalAlerts: injectCounter
      ? async () => (typeof exhausted === 'function' ? exhausted() : exhausted)
      : null,
  }));
  return app;
}

async function getHealth(app) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    return { status: res.status, json: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('an exhausted alert queue is reported', async () => {
  const app = loadApp({ exhausted: { count: 101, oldestAt: '2026-05-01T00:00:00.000Z' } });
  const { status, json } = await getHealth(app);

  assert.equal(json.queues.homeTimeInternalAlerts.available, true);
  assert.equal(json.queues.homeTimeInternalAlerts.exhausted, 101);
  assert.equal(json.queues.homeTimeInternalAlerts.oldestAt, '2026-05-01T00:00:00.000Z');
  assert.equal(status, 200, 'a stalled queue must not make the service look down to Render');
  assert.equal(json.healthy, true);
  assert.equal(json.status, 'ok');
});

test('an empty queue reports zero, not absence', async () => {
  const app = loadApp({ exhausted: { count: 0, oldestAt: null } });
  const { json } = await getHealth(app);

  assert.deepEqual(json.queues.homeTimeInternalAlerts, {
    available: true, exhausted: 0, oldestAt: null,
  });
});

test('a failing count degrades the field, never the endpoint', async () => {
  const app = loadApp({
    exhausted: () => { throw new Error('relation "home_time_requests" does not exist'); },
  });
  const { status, json } = await getHealth(app);

  assert.equal(status, 200);
  assert.equal(json.queues.homeTimeInternalAlerts.available, false);
  assert.match(json.queues.homeTimeInternalAlerts.error, /does not exist/);
});

test('the count is cached, so an uptime monitor does not query on every ping', async () => {
  let calls = 0;
  const app = loadApp({ exhausted: () => { calls += 1; return { count: 7, oldestAt: null }; } });

  await getHealth(app);
  await getHealth(app);
  await getHealth(app);

  assert.equal(calls, 1, 'health is polled constantly; the queue count must not ride along');
});

test('with no counter injected the field is absent, not an error', async () => {
  const app = loadApp({ injectCounter: false });
  const { status, json } = await getHealth(app);

  assert.equal(status, 200);
  assert.equal(json.queues.homeTimeInternalAlerts.available, false);
});

test('a down database skips the queue query entirely', async () => {
  let calls = 0;
  const app = loadApp({
    dbOk: false,
    exhausted: () => { calls += 1; return { count: 1, oldestAt: null }; },
  });
  const { status, json } = await getHealth(app);

  assert.equal(status, 503, 'a down database IS a reason to report unhealthy');
  assert.equal(calls, 0, 'no point querying a database that just failed to ping');
  assert.equal(json.queues.homeTimeInternalAlerts.available, false);
});
