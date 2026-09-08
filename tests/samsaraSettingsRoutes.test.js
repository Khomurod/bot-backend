/**
 * The Samsara settings HTTP surface.
 *
 * What is being guarded, in the order an operator meets it:
 *   • the panel says Samsara is ALREADY configured when the key is only in the
 *     environment — the deployment must not look empty and invite a re-entry;
 *   • the key never comes back out, not in a read and not in a test result;
 *   • "Test connection" can prove a candidate key BEFORE it is saved, so a bad
 *     paste never costs the working credential;
 *   • a save that omits the key leaves the stored one alone;
 *   • the recovery queue is readable without exposing payloads.
 *
 * The data layer is stubbed at the pool seam, like the other route suites, so
 * nothing here reaches a database or Samsara.
 */
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-secret';
process.env.BOT_TOKEN ||= '123:test-bot-token';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test-encryption-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const { purgeDataLayer, POOL_PATH } = require('./helpers/purgeDataLayer');

const ROUTE_PATH = path.resolve(__dirname, '../server/routes/settings/samsaraRoutes.js');
const LOCATION_PATH = path.resolve(__dirname, '../services/samsaraLocationService.js');

const SECRET = 'samsara_live_key_7788';

function makePool({ row = null, jobs = [] } = {}) {
  const writes = [];
  return {
    writes,
    query: async (sql, params = []) => {
      const flat = sql.replace(/\s+/g, ' ').trim();
      if (/SELECT \* FROM samsara_settings/i.test(flat)) return { rows: row ? [row] : [] };
      if (/^INSERT INTO samsara_settings/i.test(flat)) return { rows: [] };
      if (/^UPDATE samsara_settings/i.test(flat)) { writes.push({ sql: flat, params }); return { rows: [] }; }
      if (/FROM samsara_video_recovery_jobs/i.test(flat) && /GROUP BY status/i.test(flat)) {
        return { rows: [{ status: 'pending_retrieval', count: 2, next_due_at: new Date('2026-05-29T15:00:00Z') }] };
      }
      if (/FROM samsara_video_recovery_jobs/i.test(flat)) return { rows: jobs };
      if (/FROM eld_settings/i.test(flat)) return { rows: [] };
      throw new Error(`Unexpected query in test: ${flat.slice(0, 90)}`);
    },
  };
}

function loadApp({ pool, vehicles = [{ id: 'v1' }], testThrows = null } = {}) {
  require.cache[POOL_PATH] = { id: POOL_PATH, filename: POOL_PATH, loaded: true, exports: pool };
  purgeDataLayer([ROUTE_PATH, LOCATION_PATH]);
  const testCalls = [];
  require.cache[LOCATION_PATH] = {
    exports: {
      fetchAllVehicleStats: async (args) => {
        testCalls.push(args);
        if (testThrows) throw testThrows;
        return vehicles;
      },
      getLiveLocationForGroupTitle: async () => ({}),
    },
  };

  const { createSamsaraSettingsRouter } = require(ROUTE_PATH);
  const app = express();
  app.use(express.json());
  app.use('/api/settings', createSamsaraSettingsRouter({
    authMiddleware: (req, _res, next) => { req.admin = { username: 'admin' }; next(); },
  }));
  return { app, testCalls };
}

async function call(app, method, pathname, body) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a key that only exists in the environment still reads as configured', async (t) => {
  const saved = process.env.SAMSARA_API_KEY;
  process.env.SAMSARA_API_KEY = SECRET;
  t.after(() => {
    if (saved === undefined) delete process.env.SAMSARA_API_KEY;
    else process.env.SAMSARA_API_KEY = saved;
    purgeDataLayer([ROUTE_PATH, LOCATION_PATH]);
    delete require.cache[POOL_PATH];
  });

  const { app } = loadApp({ pool: makePool({ row: { id: 1, enabled: true } }) });
  const res = await call(app, 'GET', '/api/settings/samsara');

  assert.equal(res.status, 200);
  assert.equal(res.json.settings.apiKeySet, true, 'the panel must not look empty');
  assert.equal(res.json.settings.apiKeyFromEnv, true);
  assert.equal(res.text.includes(SECRET), false, 'the key never leaves the server');
  assert.equal(res.json.settings.apiKeyMasked, '••••7788');
  assert.equal(res.json.recovery.byStatus.pending_retrieval, 2);
});

test('a candidate key is tested without being saved', async (t) => {
  t.after(() => { purgeDataLayer([ROUTE_PATH, LOCATION_PATH]); delete require.cache[POOL_PATH]; });
  const pool = makePool({ row: { id: 1, enabled: true } });
  const { app, testCalls } = loadApp({ pool, vehicles: [{ id: 'a' }, { id: 'b' }] });

  const res = await call(app, 'POST', '/api/settings/samsara/test', { apiKey: 'candidate-key' });

  assert.equal(res.status, 200);
  assert.equal(res.json.connected, true);
  assert.match(res.json.message, /2 vehicle/);
  assert.equal(testCalls[0].apiKey, 'candidate-key', 'the pasted key is what was exercised');
  assert.deepEqual(pool.writes, [], 'and nothing was written — Save is a separate decision');
});

test('a refused key reports Samsara\'s own reason, and never the key', async (t) => {
  t.after(() => { purgeDataLayer([ROUTE_PATH, LOCATION_PATH]); delete require.cache[POOL_PATH]; });
  const { app } = loadApp({
    pool: makePool({ row: { id: 1, enabled: true } }),
    testThrows: new Error('Samsara 401: invalid token'),
  });

  const res = await call(app, 'POST', '/api/settings/samsara/test', { apiKey: SECRET });
  assert.equal(res.json.connected, false);
  assert.match(res.json.message, /401/);
  assert.equal(res.text.includes(SECRET), false);
});

test('saving the recovery settings does not touch the stored key', async (t) => {
  t.after(() => { purgeDataLayer([ROUTE_PATH, LOCATION_PATH]); delete require.cache[POOL_PATH]; });
  const pool = makePool({ row: { id: 1, enabled: true, api_key_encrypted: 'sealed' } });
  const { app } = loadApp({ pool });

  const res = await call(app, 'PUT', '/api/settings/samsara', {
    videoRecoveryEnabled: true,
    videoRecoveryInitialDelaySeconds: 300,
    videoRecoveryMaxAttempts: 12,
  });

  assert.equal(res.status, 200);
  const update = pool.writes.find((w) => /^UPDATE samsara_settings/.test(w.sql));
  assert.ok(update);
  assert.doesNotMatch(update.sql, /api_key_encrypted/, 'the working credential survives a routine save');
  assert.match(update.sql, /video_recovery_initial_delay_seconds/);
  assert.match(update.sql, /updated_by/);
});

test('the recovery queue is readable, without payloads or signed URLs', async (t) => {
  t.after(() => { purgeDataLayer([ROUTE_PATH, LOCATION_PATH]); delete require.cache[POOL_PATH]; });
  const { app } = loadApp({
    pool: makePool({
      row: { id: 1, enabled: true },
      jobs: [{
        id: 1, samsara_event_id: 'evt-1', status: 'pending_retrieval',
        attempts: 2, retrieval_id: 'ret-9', target_count: 2, last_error: null,
      }],
    }),
  });

  const res = await call(app, 'GET', '/api/settings/samsara/video-recovery?limit=10');
  assert.equal(res.status, 200);
  assert.equal(res.json.jobs.length, 1);
  assert.equal(res.json.jobs[0].samsara_event_id, 'evt-1');
  assert.equal(res.text.includes('raw_event'), false);
  assert.equal(res.text.includes('targets'), false);
});
