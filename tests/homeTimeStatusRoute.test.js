/**
 * Route tests for PUT /api/home-time/status/:groupId — the admin "Current state"
 * editor (state and/or start-date override).
 *
 * This file used to stub `setDriverHomeState` and assert only that it was
 * called. That made it the test which SHOULD have caught the admin-flip leak
 * — the route moved the flip-flop and never opened or closed a home-time cycle,
 * one of the two paths behind 74 open cycles out of 79 in production — and it
 * could not, because its stub had no road-history surface at all. A real state
 * change now goes through `applyStateTransition`, so the stub carries the whole
 * cycle surface and the tests assert the bookkeeping, not just the write.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const { DateTime } = require('luxon');
const { purgeModulePackage } = require('./helpers/purgeDataLayer');

function loadApp({ existing, captured, cycles = [], settings = { enabled: true } }) {
  const routePath = path.resolve(__dirname, '../server/routes/homeTimeRoutes.js');
  const routeDir = path.resolve(__dirname, '../server/routes/homeTime');
  const htPath = path.resolve(__dirname, '../database/homeTime.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const groupsPath = path.resolve(__dirname, '../database/groups.js');
  const servicePath = path.resolve(__dirname, '../services/homeTimeService.js');
  let current = existing;

  // The sub-router that owns PUT /status captures the `ht` stub at require
  // time, so purging the façade alone left the PREVIOUS case's stub in place
  // and later cases asserted against the first case's captured writes. The
  // whole package is dropped by walking the directory, which cannot miss a
  // module added by a later split.
  purgeModulePackage(routePath, routeDir, [htPath, dbPath]);
  delete require.cache[servicePath];

  require.cache[dbPath] = { exports: { async getDriverProfileByGroupId() { return null; } } };
  require.cache[groupsPath] = {
    exports: {
      async getGroupByIdAnyType(id) {
        return { id, telegram_group_id: -100, group_name: 'WENZE UNIT # 7 A', group_type: 'driver' };
      },
    },
  };
  require.cache[htPath] = {
    exports: {
      async getHomeTimeSettings() {
        return { road_allowance_weeks: 4, bonus_per_week: 100, ...settings };
      },
      async getDriverHomeStatus() { return current; },
      async setDriverHomeState(groupId, patch) {
        captured.push({ groupId, patch });
        current = {
          group_id: groupId,
          state: patch.state || current.state,
          state_since: patch.stateSince || current.state_since,
        };
        return current;
      },
      async upsertDriverHomeStatus(patch) {
        captured.push({ groupId: patch.groupId, patch: { state: patch.state, stateSince: patch.stateSince } });
        current = {
          group_id: patch.groupId, state: patch.state, state_since: patch.stateSince,
        };
      },
      async touchDriverHomeStatus() {},
      async setDriverHomeStateSince() { return null; },
      // The cycle surface whose absence made the leak invisible here.
      async insertRoadHistory(row) {
        const created = {
          id: cycles.length + 1, group_id: row.groupId, return_to_road_at: null, bonus_posted_at: null,
          road_started_at: row.roadStartedAt, home_arrived_at: row.homeArrivedAt, bonus_usd: row.bonusUsd,
        };
        cycles.push(created);
        return created;
      },
      async getOpenHomeStay() {
        const open = cycles.filter((c) => c.return_to_road_at == null);
        return open.length ? open[open.length - 1] : null;
      },
      async listOpenHomeStays() {
        return cycles.filter((c) => c.return_to_road_at == null).slice().reverse();
      },
      async closeHomeStay(id, { returnToRoadAt, homeDays }) {
        const row = cycles.find((c) => c.id === id && c.return_to_road_at == null);
        if (!row) return null;
        row.return_to_road_at = returnToRoadAt;
        row.home_days = homeDays ?? null;
        return row;
      },
      async claimRoadBonusPost(id) {
        const row = cycles.find((c) => c.id === id);
        if (row) row.bonus_posted_at = new Date().toISOString();
        return row || null;
      },
      async findDecidedRequestNearDate() { return null; },
      async expireOpenClarificationsForGroup() {},
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
  const cycles = [];
  const app = loadApp({ existing: EXISTING, captured, cycles });
  const res = await put(app, '/api/home-time/status/7', { state: 'home' });
  assert.equal(res.status, 200);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].patch.state, 'home');
  assert.equal(cycles.length, 1,
    'road→home opens a cycle — the admin route used to record nothing at all');
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
