/**
 * Unified TrailerStateService — pure normalization, display status, and map
 * marker rules. No DB required for these (the DB-backed getters are covered by
 * the PG integration test); here we exercise the deterministic mappers.
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token-2';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test-key';
process.env.CORS_ALLOW_ALL ||= 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../services/trailerStateService');

test('display status: dropped defaults to empty label', () => {
  assert.equal(svc.buildDisplayStatus('dropped', 'empty', false), 'Dropped / Empty');
  assert.equal(svc.buildDisplayStatus('dropped', 'loaded', false), 'Dropped / Loaded');
  assert.equal(svc.buildDisplayStatus('with_driver', 'unknown', false), 'With driver / Unknown cargo');
  assert.equal(svc.buildDisplayStatus('with_driver', 'empty', false), 'With driver / Empty');
  assert.equal(svc.buildDisplayStatus('with_driver', 'loaded', false), 'With driver / Loaded');
});

test('display status: unknown possession + review → Needs review', () => {
  assert.equal(svc.buildDisplayStatus('unknown', 'unknown', true), 'Unknown / Needs review');
  assert.equal(svc.buildDisplayStatus('unknown', 'unknown', false), 'Unknown');
});

test('marker color distinguishes dropped empty vs dropped loaded', () => {
  const empty = svc.markerColor('dropped', 'empty');
  const loaded = svc.markerColor('dropped', 'loaded');
  assert.notEqual(empty, loaded);
  assert.equal(empty, svc.COLOR.droppedEmpty);
  assert.equal(loaded, svc.COLOR.droppedLoaded);
});

test('normalizeState builds a full state object with a rectangle map marker', () => {
  const s = svc.normalizeState({
    trailer_id: 7, unit_number: '171847',
    possession_status: 'dropped', cargo_status: 'empty',
    current_lat: 40.0, current_lng: -76.3, location_source: 'geocoded',
    status_needs_review: false, current_driver_name: null,
  });
  assert.equal(s.unit_number, '171847');
  assert.equal(s.display_status, 'Dropped / Empty');
  assert.equal(s.map_marker.shape, 'rectangle');
  assert.equal(s.map_marker.color, svc.COLOR.droppedEmpty);
  assert.equal(s.map_marker.attached_to_driver, false);
  assert.equal(s.mappable, true);
});

test('with_driver trailer is mappable (derives from truck) and marker attaches', () => {
  const s = svc.normalizeState({
    trailer_id: 8, unit_number: '403279',
    possession_status: 'with_driver', cargo_status: 'unknown',
    current_lat: null, current_lng: null,
    status_needs_review: false, current_driver_name: 'John Doe',
  });
  assert.equal(s.mappable, true);
  assert.equal(s.map_marker.attached_to_driver, true);
});

test('needs_review sets a red outline', () => {
  const s = svc.normalizeState({
    trailer_id: 9, unit_number: 'X', possession_status: 'unknown',
    cargo_status: 'unknown', status_needs_review: true,
  });
  assert.equal(s.map_marker.outline, '#ef4444');
  assert.equal(s.needs_review, true);
  assert.equal(s.review_status, 'pending');
});

test('approximate_state source renders a dashed marker', () => {
  const s = svc.normalizeState({
    trailer_id: 10, unit_number: 'Y', possession_status: 'dropped',
    cargo_status: 'empty', current_lat: 41, current_lng: -80,
    location_source: 'approximate_state', status_needs_review: false,
  });
  assert.equal(s.map_marker.dashed, true);
});

// ─── a database failure must not look like an empty fleet ─────────────────────

/**
 * These three getters used to catch every error and return `[]` / `null` / an
 * empty map payload. An unreachable database, an exhausted transfer allowance
 * and a rejected credential all rendered as "this company owns no trailers" —
 * on the same screen someone uses to decide a trailer is unaccounted for. The
 * failure is propagated now, and the route reports which kind it was.
 */
const DB_PATH = require.resolve('../database/db');

/** Load trailerStateService with a database module that fails the way an outage does. */
function loadWithFailingDb(error) {
  const servicePath = require.resolve('../services/trailerStateService');
  const realDb = require.cache[DB_PATH];
  delete require.cache[servicePath];
  require.cache[DB_PATH] = {
    id: DB_PATH,
    filename: DB_PATH,
    loaded: true,
    exports: {
      getUnifiedTrailerStates: async () => { throw error; },
      getUnifiedTrailerStateById: async () => { throw error; },
    },
  };
  try {
    return require(servicePath);
  } finally {
    delete require.cache[servicePath];
    if (realDb) require.cache[DB_PATH] = realDb; else delete require.cache[DB_PATH];
  }
}

test('a database outage propagates instead of returning an empty trailer list', async () => {
  const outage = Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' });
  const failing = loadWithFailingDb(outage);
  await assert.rejects(() => failing.getUnifiedTrailerStates(), /Connection terminated/);
  await assert.rejects(() => failing.getUnifiedTrailerStateById(7), /Connection terminated/);
  await assert.rejects(() => failing.getTrailerMapPayload(), /Connection terminated/);
});

test('the map payload still separates mappable trailers when the database answers', async () => {
  // The happy path must be unchanged by the above: this is the shape the
  // dispatch map consumes.
  const servicePath = require.resolve('../services/trailerStateService');
  const realDb = require.cache[DB_PATH];
  delete require.cache[servicePath];
  require.cache[DB_PATH] = {
    id: DB_PATH,
    filename: DB_PATH,
    loaded: true,
    exports: {
      getUnifiedTrailerStates: async () => ([
        { trailer_id: 1, unit_number: 'A1', possession_status: 'dropped', cargo_status: 'empty', current_lat: 40, current_lng: -76 },
        { trailer_id: 2, unit_number: 'B2', possession_status: 'unknown', cargo_status: 'unknown', status_needs_review: true },
      ]),
      getUnifiedTrailerStateById: async () => null,
    },
  };
  let payload;
  try {
    const loaded = require(servicePath);
    payload = await loaded.getTrailerMapPayload();
  } finally {
    delete require.cache[servicePath];
    if (realDb) require.cache[DB_PATH] = realDb; else delete require.cache[DB_PATH];
  }
  assert.equal(payload.trailers.length, 1);
  assert.equal(payload.trailers[0].unit_number, 'A1');
  assert.equal(payload.noLocation.length, 1);
  assert.equal(payload.noLocation[0].reason, 'needs review');
  assert.equal(payload.meta.count, 2);
  assert.ok(!payload.meta.error, 'a successful payload carries no error flag');
});
