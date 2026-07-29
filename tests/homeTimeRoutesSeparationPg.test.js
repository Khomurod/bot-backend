/**
 * Home-Time admin API — ROUTE SEPARATION regression suite (real PostgreSQL).
 *
 * These exist because a refactor silently collapsed two endpoints into one:
 * `PUT /requests/:id` ended up calling the SETTINGS validator and writing
 * home_time_settings, while `PUT /settings` disappeared entirely. The admin
 * panel kept reporting success, so editing a request's dates quietly rewrote
 * global settings and saving settings 404'd.
 *
 * Source-text assertions would not have caught that — the code looked
 * plausible. So these drive the real Express router against a real database and
 * assert on which ROW actually changed. That is the only check that fails when
 * the wiring is wrong.
 *
 * Requires TEST_DATABASE_URL (see CLAUDE.md → PostgreSQL integration tests).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const http = require('node:http');
const { Pool } = require('pg');

const { skipWithoutPg } = require('./helpers/trailerPgHarness');

const REPO = path.resolve(__dirname, '..');
const POOL_PATH = require.resolve('../database/pool');

/**
 * Stand up a throwaway UTF8 database with the real baseline + every forward
 * migration, then mount the real Home-Time router on a real HTTP server with
 * auth stubbed out.
 */
async function createApiHarness(t) {
  const dbName = `htroutes_${crypto.randomBytes(6).toString('hex')}`;
  const adminUrl = process.env.TEST_DATABASE_URL;
  const dbUrl = new URL(adminUrl);
  dbUrl.pathname = `/${dbName}`;

  const quiet = (p) => { p.on('error', () => {}); return p; };
  const admin = quiet(new Pool({ connectionString: adminUrl, max: 2 }));
  // UTF8 + template0: schema.sql contains box-drawing characters in comments.
  await admin.query(`CREATE DATABASE ${dbName} WITH ENCODING 'UTF8' TEMPLATE template0`);
  const pool = quiet(new Pool({ connectionString: dbUrl.toString(), max: 4 }));

  // Baseline, then the REAL forward-migration runner — so these tests exercise
  // 0001 and 0002 exactly as production applies them on boot.
  const fs = require('node:fs');
  await pool.query(fs.readFileSync(path.join(REPO, 'database/schema.sql'), 'utf8'));
  const { runMigrations } = require('../database/migrate');
  await runMigrations(pool, { silent: true });

  // Point the app's shared pool at this database, then load the router fresh so
  // every layer below it binds to the throwaway database. database/pool.js
  // exports { pool, query, ping } — same override shape as trailerPgHarness.
  const prior = require.cache[POOL_PATH];
  require.cache[POOL_PATH] = {
    id: POOL_PATH,
    filename: POOL_PATH,
    loaded: true,
    exports: {
      pool,
      query: (text, values) => pool.query(text, values),
      ping: async () => true,
    },
  };

  // Every module that captured `query` at load time must be re-required so it
  // binds to the throwaway database. Missing one leaves it pointed at the real
  // pool and the test silently exercises the wrong database.
  const reload = [
    '../database/db', '../database/homeTime', '../database/homeTimeClarification',
    '../database/homeTimeInternalAlertOutbox', '../database/homeTimeExpiry',
    '../services/homeTimeSilentModeTransition',
    '../services/homeTimeInternalAlert',
    '../server/routes/homeTimeRoutes', '../server/routes/homeTimeDecisionRoutes',
    '../server/routes/homeTimeRequestRoutes',
  ];
  for (const p of reload) delete require.cache[require.resolve(p)];
  t.after(() => { for (const p of reload) delete require.cache[require.resolve(p)]; });

  const express = require('express');
  const { createHomeTimeRouter } = require('../server/routes/homeTimeRoutes');
  const app = express();
  app.use(express.json());
  app.use('/api/home-time', createHomeTimeRouter({ authMiddleware: (req, _res, next) => next() }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/home-time`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (prior) require.cache[POOL_PATH] = prior; else delete require.cache[POOL_PATH];
    await pool.end().catch(() => {});
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  async function api(method, urlPath, body) {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* empty body */ }
    return { status: res.status, body: json };
  }

  async function settings() {
    const r = await pool.query('SELECT * FROM home_time_settings WHERE id = 1');
    return r.rows[0];
  }

  /** Insert a driver group + a request awaiting its return date. */
  async function seedRequest(over = {}) {
    const g = await pool.query(
      `INSERT INTO groups (telegram_group_id, group_name, group_type)
       VALUES ($1, 'WENZE UNIT # 96266', 'driver') RETURNING id`,
      [-1000000 - Math.floor(Math.random() * 100000)],
    );
    const groupId = g.rows[0].id;
    const r = await pool.query(
      `INSERT INTO home_time_requests
         (group_id, driver_name, unit_number, status, home_from, return_to_road_date,
          next_reminder_at, clarification_channel)
       VALUES ($1, 'Pascal F', '96266', $2, $3, $4, $5, 'driver') RETURNING *`,
      [groupId, over.status || 'awaiting_return_to_road', over.home_from || '2099-08-02',
        over.return_to_road_date || null, over.next_reminder_at || null],
    );
    return { groupId, request: r.rows[0] };
  }

  /**
   * The request row, with the DATE columns cast to text in SQL.
   *
   * node-pg turns a DATE into a JS Date at LOCAL midnight, so formatting it in
   * JS is both ugly and timezone-dependent (toISOString can slide a day). Let
   * Postgres render the calendar date it actually stored.
   */
  async function getRequest(id) {
    const r = await pool.query(
      `SELECT *,
              to_char(home_from, 'YYYY-MM-DD')            AS home_from_text,
              to_char(home_to, 'YYYY-MM-DD')              AS home_to_text,
              to_char(return_to_road_date, 'YYYY-MM-DD')  AS return_to_road_text
         FROM home_time_requests WHERE id = $1`,
      [id],
    );
    return r.rows[0];
  }

  return {
    pool, api, settings, seedRequest, getRequest,
  };
}

const opts = { skip: skipWithoutPg() };

// ── PUT /settings exists and writes ONLY settings ──

test('PUT /settings updates the two silent-mode settings', opts, async (t) => {
  const h = await createApiHarness(t);
  const res = await h.api('PUT', '/settings', {
    driver_clarification_enabled: false,
    internal_clarification_group_id: '-1008888',
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.settings, 'response contract is { settings }');
  assert.equal(res.body.settings.driver_clarification_enabled, false);
  assert.equal(res.body.settings.internal_clarification_group_id, '-1008888');

  const row = await h.settings();
  assert.equal(row.driver_clarification_enabled, false, 'persisted to the database');
  assert.equal(row.internal_clarification_group_id, '-1008888');
});

test('PUT /settings does NOT modify any home-time request', opts, async (t) => {
  const h = await createApiHarness(t);
  const { request } = await h.seedRequest({ return_to_road_date: '2099-08-06' });
  const before = await h.getRequest(request.id);

  await h.api('PUT', '/settings', { driver_clarification_enabled: false });

  const after = await h.getRequest(request.id);
  assert.deepEqual(
    {
      home_from: after.home_from, return_to_road_date: after.return_to_road_date, status: after.status,
    },
    {
      home_from: before.home_from, return_to_road_date: before.return_to_road_date, status: before.status,
    },
    'the request row must be untouched by a settings save',
  );
});

test('PUT /settings supports partial updates without erasing unrelated settings', opts, async (t) => {
  const h = await createApiHarness(t);
  await h.api('PUT', '/settings', {
    road_allowance_weeks: 6,
    completed_notify_group_id: '-1009999',
    internal_clarification_group_id: '-1008888',
  });
  // A later, unrelated single-field save must not clear the group ids.
  const res = await h.api('PUT', '/settings', { home_allowance_days: 5 });
  assert.equal(res.status, 200);

  const row = await h.settings();
  assert.equal(row.home_allowance_days, 5);
  assert.equal(row.road_allowance_weeks, 6, 'unrelated setting preserved');
  assert.equal(row.completed_notify_group_id, '-1009999', 'unrelated group preserved');
  assert.equal(row.internal_clarification_group_id, '-1008888', 'unrelated group preserved');
});

test('PUT /settings rejects a non-numeric internal group id', opts, async (t) => {
  const h = await createApiHarness(t);
  const res = await h.api('PUT', '/settings', { internal_clarification_group_id: '@staffgroup' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /internal_clarification_group_id must be a numeric Telegram chat id/);

  const row = await h.settings();
  assert.equal(row.internal_clarification_group_id, null, 'nothing was written');
});

test('PUT /settings accepts a negative supergroup id', opts, async (t) => {
  const h = await createApiHarness(t);
  const res = await h.api('PUT', '/settings', { internal_clarification_group_id: '-1001234567890' });
  assert.equal(res.status, 200);
  assert.equal((await h.settings()).internal_clarification_group_id, '-1001234567890');
});

test('PUT /settings rejects out-of-range numbers', opts, async (t) => {
  const h = await createApiHarness(t);
  const res = await h.api('PUT', '/settings', { road_allowance_weeks: 99 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /road_allowance_weeks must be 1-52/);
});

// ── PUT /requests/:id writes ONLY that request ──

test('PUT /requests/:id updates the selected request dates', opts, async (t) => {
  const h = await createApiHarness(t);
  const { request } = await h.seedRequest();

  const res = await h.api('PUT', `/requests/${request.id}`, {
    home_from: '2099-08-02', return_to_road_date: '2099-08-06',
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.request, 'response contract is { request }');
  assert.equal(res.body.request.id, request.id);

  const row = await h.getRequest(request.id);
  assert.equal(row.home_from_text, '2099-08-02');
  assert.equal(row.return_to_road_text, '2099-08-06');
  // home_to is kept consistent as the last day home (return − 1).
  assert.equal(row.home_to_text, '2099-08-05');
});

test('PUT /requests/:id does NOT modify home-time settings', opts, async (t) => {
  const h = await createApiHarness(t);
  const { request } = await h.seedRequest();
  const before = await h.settings();

  const res = await h.api('PUT', `/requests/${request.id}`, {
    home_from: '2099-08-02', return_to_road_date: '2099-08-06',
  });
  assert.equal(res.status, 200);

  const after = await h.settings();
  assert.deepEqual(after, before, 'the settings row must be byte-identical after a request edit');
});

test('PUT /requests/:id with settings-shaped keys does not write settings', opts, async (t) => {
  // The exact shape the broken wiring accepted. It must now be rejected as
  // "no updatable field", and settings must stay untouched.
  const h = await createApiHarness(t);
  const { request } = await h.seedRequest();
  const before = await h.settings();

  const res = await h.api('PUT', `/requests/${request.id}`, {
    driver_clarification_enabled: false, internal_clarification_group_id: '-1008888',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /at least one field/i);
  assert.deepEqual(await h.settings(), before, 'settings untouched');
});

test('PUT /requests/:id rejects an invalid id with 400', opts, async (t) => {
  const h = await createApiHarness(t);
  for (const bad of ['abc', '0', '-3']) {
    const res = await h.api('PUT', `/requests/${bad}`, { home_from: '2099-08-02' });
    assert.equal(res.status, 400, `id=${bad}`);
    assert.match(res.body.error, /Invalid request id/);
  }
});

test('PUT /requests/:id returns 404 for a missing request', opts, async (t) => {
  const h = await createApiHarness(t);
  const res = await h.api('PUT', '/requests/99999999', { home_from: '2099-08-02' });
  assert.equal(res.status, 404);
  assert.match(res.body.error, /Request not found/);
});

test('PUT /requests/:id rejects a malformed date with 400', opts, async (t) => {
  const h = await createApiHarness(t);
  const { request } = await h.seedRequest();
  const res = await h.api('PUT', `/requests/${request.id}`, { home_from: '02/08/2099' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /home_from must be YYYY-MM-DD/);
});

test('PUT /requests/:id rejects a return date on or before the home-start date', opts, async (t) => {
  const h = await createApiHarness(t);
  const { request } = await h.seedRequest();
  for (const ret of ['2099-08-02', '2099-08-01']) {
    const res = await h.api('PUT', `/requests/${request.id}`, {
      home_from: '2099-08-02', return_to_road_date: ret,
    });
    assert.equal(res.status, 400, `return=${ret}`);
    assert.match(res.body.error, /return_to_road_date must be after home_from/);
  }
});

test('PUT /requests/:id stops pending reminders when the flow is resolved', opts, async (t) => {
  const h = await createApiHarness(t);
  const soon = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
  for (const status of ['cancelled', 'expired', 'approved', 'denied']) {
    // eslint-disable-next-line no-await-in-loop
    const { request } = await h.seedRequest({ next_reminder_at: soon });
    // eslint-disable-next-line no-await-in-loop
    const res = await h.api('PUT', `/requests/${request.id}`, { status });
    assert.equal(res.status, 200, status);
    // eslint-disable-next-line no-await-in-loop
    const row = await h.getRequest(request.id);
    assert.equal(row.status, status);
    assert.equal(row.next_reminder_at, null, `${status} must clear the reminder clock`);
  }
});

test('PUT /requests/:id rejects an unknown status', opts, async (t) => {
  const h = await createApiHarness(t);
  const { request } = await h.seedRequest();
  const res = await h.api('PUT', `/requests/${request.id}`, { status: 'bogus' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /invalid status/);
});

// ── the two endpoints really are distinct handlers ──

test('settings and request edits interleave without cross-contamination', opts, async (t) => {
  const h = await createApiHarness(t);
  const { request } = await h.seedRequest();

  await h.api('PUT', '/settings', { internal_clarification_group_id: '-1008888', road_allowance_weeks: 5 });
  await h.api('PUT', `/requests/${request.id}`, { home_from: '2099-09-01', return_to_road_date: '2099-09-05' });
  await h.api('PUT', '/settings', { home_allowance_days: 3 });

  const s = await h.settings();
  const r = await h.getRequest(request.id);
  assert.equal(s.internal_clarification_group_id, '-1008888');
  assert.equal(s.road_allowance_weeks, 5);
  assert.equal(s.home_allowance_days, 3);
  assert.equal(r.home_from_text, '2099-09-01');
  assert.equal(r.return_to_road_text, '2099-09-05');
});
