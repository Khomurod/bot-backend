/**
 * Route tests for PUT /api/home-time/status/:groupId — the admin "Current state"
 * editor (state and/or start-date override).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const { DateTime } = require('luxon');

function loadApp({ existing, captured }) {
  const routePath = path.resolve(__dirname, '../server/routes/homeTimeRoutes.js');
  const htPath = path.resolve(__dirname, '../database/homeTime.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');

  for (const p of [routePath, htPath, dbPath]) delete require.cache[p];

  require.cache[dbPath] = { exports: { async getDriverProfileByGroupId() { return null; } } };
  require.cache[htPath] = {
    exports: {
      async getDriverHomeStatus() { return existing; },
      async setDriverHomeState(groupId, patch) {
        captured.push({ groupId, patch });
        return {
          group_id: groupId,
          state: patch.state || existing.state,
          state_since: patch.stateSince || existing.state_since,
        };
      },
      async setDriverHomeStateSince() { return null; },
    },
  };

  const { createHomeTimeRouter } = require(routePath);
  const app = express();
  app.use(express.json());
  app.use('/api/home-time', createHomeTimeRouter({ authMiddleware: (req, _res, next) => { req.admin = { username: 'admin' }; next(); } }));
  return app;
}

async function put(app, pathname, body) {
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}${pathname}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
    return { status: res.status, json };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const EXISTING = { state: 'road', state_since: '2026-05-01T00:00:00.000Z' };

test('flipping state without a date resets the clock to now', async () => {
  const captured = [];
  const app = loadApp({ existing: EXISTING, captured });
  const res = await put(app, '/api/home-time/status/7', { state: 'home' });
  assert.equal(res.status, 200);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].patch.state, 'home');
  // A fresh start date (today) was injected because the state changed.
  const since = DateTime.fromISO(captured[0].patch.stateSince);
  assert.ok(since.isValid);
  assert.ok(Math.abs(since.diffNow('minutes').minutes) < 5);
});

test('changing only the start date keeps the existing state', async () => {
  const captured = [];
  const app = loadApp({ existing: EXISTING, captured });
  const res = await put(app, '/api/home-time/status/7', { state_since: '2026-04-01' });
  assert.equal(res.status, 200);
  assert.equal(captured[0].patch.state, null);
  assert.match(captured[0].patch.stateSince, /^2026-04-01/);
});

test('setting the same state with a new date does not force "now"', async () => {
  const captured = [];
  const app = loadApp({ existing: EXISTING, captured });
  const res = await put(app, '/api/home-time/status/7', { state: 'road', state_since: '2026-04-15' });
  assert.equal(res.status, 200);
  assert.equal(captured[0].patch.state, 'road');
  assert.match(captured[0].patch.stateSince, /^2026-04-15/);
});

test('rejects an invalid state value', async () => {
  const captured = [];
  const app = loadApp({ existing: EXISTING, captured });
  const res = await put(app, '/api/home-time/status/7', { state: 'vacation' });
  assert.equal(res.status, 400);
  assert.equal(captured.length, 0);
});

test('rejects an empty body (no state, no date)', async () => {
  const captured = [];
  const app = loadApp({ existing: EXISTING, captured });
  const res = await put(app, '/api/home-time/status/7', {});
  assert.equal(res.status, 400);
});

test('rejects a future start date', async () => {
  const captured = [];
  const app = loadApp({ existing: EXISTING, captured });
  const future = DateTime.now().plus({ days: 5 }).toISODate();
  const res = await put(app, '/api/home-time/status/7', { state_since: future });
  assert.equal(res.status, 400);
});

test('404 when no tracked status exists for the group', async () => {
  const captured = [];
  const app = loadApp({ existing: null, captured });
  const res = await put(app, '/api/home-time/status/7', { state: 'home' });
  assert.equal(res.status, 404);
});
