'use strict';

/**
 * GET /api/settings/fleet-crosscheck: behind the admin login, passes ?refresh,
 * and a failure comes back as a classified error rather than a crash.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createFleetCrossCheckRouter } = require('../server/routes/settings/fleetCrossCheckRoutes');

function appWith(crossCheck, { allow = true } = {}) {
  const app = express();
  app.use('/api/settings', createFleetCrossCheckRouter({
    authMiddleware: (req, res, next) => (allow ? next() : res.status(401).json({ error: 'login' })),
    crossCheck,
  }));
  return app;
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

test('answers with the report and passes refresh', async () => {
  const seen = [];
  const app = appWith({ getReport: async (o) => { seen.push(o); return { summary: { boardRows: 3 }, rows: [] }; } });
  const a = await get(app, '/api/settings/fleet-crosscheck');
  assert.equal(a.status, 200);
  assert.equal(a.body.summary.boardRows, 3);
  await get(app, '/api/settings/fleet-crosscheck?refresh=1');
  assert.deepEqual(seen, [{ refresh: false }, { refresh: true }]);
});

test('behind the admin login', async () => {
  const app = appWith({ getReport: async () => ({}) }, { allow: false });
  assert.equal((await get(app, '/api/settings/fleet-crosscheck')).status, 401);
});

test('a failed build is an error response, not a crash', async () => {
  const app = appWith({ getReport: async () => { throw new Error('db down'); } });
  const r = await get(app, '/api/settings/fleet-crosscheck');
  assert.ok(r.status >= 500);
  assert.match(r.body.error, /fleet comparison/);
});
