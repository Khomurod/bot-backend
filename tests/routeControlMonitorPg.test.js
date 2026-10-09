'use strict';

/**
 * The Route Control monitor's statements, against the REAL schema.
 *
 * The monitor tick now names its columns instead of reading whole rows, reads
 * a route's polyline only when it is needed, and reads nothing back from its
 * writes (tests/routeMonitorQueries.test.js pins the shape of a tick). A fake
 * answers whatever it is told; only PostgreSQL can say that every named column
 * exists, that the values arrive with the same types as from `SELECT r.*`, that
 * md5() of a missing polyline is NULL, and that two completions racing on one
 * route still produce exactly one winner.
 *
 * Needs TEST_DATABASE_URL and SKIPS without it. A skipped test is not a passing
 * test (CLAUDE.md); CI fails on any skip.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const POLYLINE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const OTHER_POLYLINE = '_p~iF~ps|U_ulLnnqC';

/** Exactly what the monitor and everything it calls read from a route. */
const PASS_COLUMNS = [
  'id', 'group_id', 'unit_number', 'status', 'tracking_status', 'tracking_start_mode', 'tracking_start_at',
  'tracking_start_lat', 'tracking_start_lng', 'tracking_start_radius_miles', 'tracking_hold_reason',
  'driver_group_message_sent_at', 'destination_lat', 'destination_lng', 'destination_text',
  'destination_repair_attempts', 'destination_repair_last_at', 'consecutive_off_route', 'last_notification_at',
  'polyline_version', 'group_name', 'telegram_group_id',
].sort();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = h.loadDataLayer(['routeControl', 'gmapsSettings']);
  return { h, rc: layer.routeControl, gmaps: layer.gmapsSettings };
}

let nextChat = 1;
async function addGroup(h, name) {
  const res = await h.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type, active)
     VALUES ($1, $2, 'driver', TRUE) RETURNING id`,
    [String(-1001000000000 - (nextChat += 1)), name]
  );
  return res.rows[0].id;
}

async function addRoute(h, fields = {}) {
  const row = { original_url: 'https://www.google.com/maps/dir/Chicago/Dallas', status: 'active', ...fields };
  const cols = Object.keys(row);
  const res = await h.query(
    `INSERT INTO route_assignments (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    cols.map((c) => row[c])
  );
  return res.rows[0].id;
}

const routeById = async (h, id) => (await h.query('SELECT * FROM route_assignments WHERE id = $1', [id])).rows[0];

test('the pass reads exactly the columns it uses, from active routes only, oldest first', { skip: skipWithoutPg() }, async (t) => {
  const { h, rc } = await setup(t);
  const groupId = await addGroup(h, 'WENZE UNIT 512 TEST DRIVER');
  const tracked = await addRoute(h, {
    group_id: groupId, unit_number: '512', encoded_polyline: POLYLINE, destination_text: 'Dallas, TX',
    destination_lat: 32.9, destination_lng: -96.8, tracking_status: 'pending',
    tracking_start_mode: 'start_location', tracking_start_lat: 35.23, tracking_start_lng: -85.71,
    tracking_start_radius_miles: 2, tracking_start_at: '2026-10-09T15:00:00Z', tracking_hold_reason: 'waiting_for_location',
    driver_group_message_sent_at: '2026-10-08T12:00:00Z', destination_repair_last_at: '2026-10-08T13:00:00Z',
    destination_repair_attempts: 1, consecutive_off_route: 2, last_notification_at: '2026-10-08T14:00:00Z',
    waypoints: JSON.stringify([{ raw: 'St. Louis, MO' }]), driver_group_messages: JSON.stringify([{ message_id: 7, kind: 'text' }]),
    updated_at: '2026-10-08T12:00:00Z',
  });
  const orphan = await addRoute(h, { updated_at: '2026-10-08T11:00:00Z' }); // no group, no polyline
  await addRoute(h, { status: 'completed', group_id: groupId });
  await addRoute(h, { status: 'cancelled', group_id: groupId });

  const rows = await rc.listMonitorPassAssignments();
  assert.deepEqual(rows.map((r) => r.id), [orphan, tracked], 'every active route, oldest update first');
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), PASS_COLUMNS);

  const [bare, full] = rows;
  assert.equal(full.polyline_version, md5(POLYLINE), 'the polyline is represented by its fingerprint only');
  assert.equal(bare.polyline_version, null, 'no polyline, no fingerprint — and nothing to fetch');
  assert.equal(bare.group_name, null, 'a route whose group is gone still surfaces');

  // Every value arrives exactly as the whole-row read delivered it, types included.
  const whole = (await h.query(
    `SELECT r.*, g.group_name, g.telegram_group_id FROM route_assignments r
       LEFT JOIN groups g ON g.id = r.group_id WHERE r.id = $1`, [tracked]
  )).rows[0];
  for (const column of PASS_COLUMNS.filter((c) => c !== 'polyline_version')) {
    assert.deepEqual(full[column], whole[column], column);
  }
});

test('with no active route the pass returns nothing', { skip: skipWithoutPg() }, async (t) => {
  const { h, rc } = await setup(t);
  await addRoute(h, { status: 'completed' });
  assert.deepEqual(await rc.listMonitorPassAssignments(), []);
});

test('the polyline arrives with the fingerprint the pass saw, and only a new polyline changes it', { skip: skipWithoutPg() }, async (t) => {
  const { h, rc } = await setup(t);
  const id = await addRoute(h, { encoded_polyline: POLYLINE });
  const seen = (await rc.listMonitorPassAssignments())[0].polyline_version;
  assert.deepEqual(await rc.getAssignmentPolyline(id), { encoded_polyline: POLYLINE, polyline_version: seen });

  // The monitor rewrites the row (and its updated_at) on every tick. That must
  // not look like a new polyline, or the remembered copy would never be used.
  await rc.updateRouteAssignmentMonitorState(id, { lastCheckedAt: new Date().toISOString(), lastCheckResult: 'on_route' });
  await rc.updateCompletionDiagnostics(id, { blockedReason: 'OUTSIDE_COMPLETION_RADIUS' });
  assert.equal((await rc.listMonitorPassAssignments())[0].polyline_version, seen);

  await h.query('UPDATE route_assignments SET encoded_polyline = $2 WHERE id = $1', [id, OTHER_POLYLINE]);
  const changed = (await rc.listMonitorPassAssignments())[0].polyline_version;
  assert.notEqual(changed, seen, 'a recomputed route gets a new fingerprint');
  assert.deepEqual(await rc.getAssignmentPolyline(id), { encoded_polyline: OTHER_POLYLINE, polyline_version: changed });
  assert.equal(await rc.getAssignmentPolyline(id + 1000), null);
});

test("the tick's writes land in full and read nothing back", { skip: skipWithoutPg() }, async (t) => {
  const { h, rc } = await setup(t);
  const id = await addRoute(h, { last_notification_at: '2026-10-08T14:00:00Z' });

  assert.equal(await rc.updateRouteAssignmentMonitorState(id, {
    lastCheckedAt: '2026-10-09T12:00:00Z', lastLatitude: 38.5, lastLongitude: -119, lastDeviationMeters: 1500.5,
    lastCheckResult: 'off_route', consecutiveOffRoute: 2, lastNotificationAt: null,
  }), undefined);
  let row = await routeById(h, id);
  assert.equal(row.last_check_result, 'off_route');
  assert.equal(row.consecutive_off_route, 2);
  assert.equal(row.last_deviation_meters, 1500.5);
  assert.equal(row.last_notification_at.toISOString(), '2026-10-08T14:00:00.000Z', 'no warning keeps the last one');

  assert.equal(await rc.updateCompletionDiagnostics(id, {
    distanceMeters: 1234.5, blockedReason: 'OUTSIDE_COMPLETION_RADIUS',
  }), undefined);
  assert.equal(await rc.setTrackingHoldReason(id, 'waiting_for_time'), undefined);
  assert.equal(await rc.setRouteAssignmentDestinationCoords(id, { lat: 32.9, lng: -96.8 }), undefined);
  row = await routeById(h, id);
  assert.equal(row.last_destination_distance_meters, 1234.5);
  assert.equal(row.completion_blocked_reason, 'OUTSIDE_COMPLETION_RADIUS');
  assert.ok(row.last_completion_check_at);
  assert.equal(row.tracking_hold_reason, 'waiting_for_time');
  assert.deepEqual([row.destination_lat, row.destination_lng], [32.9, -96.8]);

  assert.equal(await rc.recordRouteMonitorEvent({
    assignmentId: id, eventType: 'check', result: 'on_route', latitude: 38.5, longitude: -120.2,
    deviationMeters: 12.5, detail: 'within threshold',
  }), undefined);
  const events = (await h.query('SELECT * FROM route_monitor_events WHERE assignment_id = $1', [id])).rows;
  assert.equal(events.length, 1);
  assert.deepEqual(
    [events[0].event_type, events[0].result, events[0].latitude, events[0].deviation_meters, events[0].detail],
    ['check', 'on_route', 38.5, 12.5, 'within threshold']
  );

  // A pending route starts once; a second start never moves its start time.
  const pending = await addRoute(h, { tracking_status: 'pending', tracking_hold_reason: 'waiting_for_message' });
  assert.equal(await rc.activatePendingTracking(pending), undefined);
  const started = await routeById(h, pending);
  assert.deepEqual([started.tracking_status, started.tracking_hold_reason], ['active', null]);
  assert.ok(started.tracking_started_at);
  await rc.activatePendingTracking(pending);
  assert.deepEqual((await routeById(h, pending)).tracking_started_at, started.tracking_started_at);

  // The variants other callers use still hand the row back, unchanged.
  assert.equal((await rc.insertRouteMonitorEvent({ assignmentId: id, eventType: 'cancelled' })).event_type, 'cancelled');
  const other = await addRoute(h, { tracking_status: 'pending' });
  assert.equal((await rc.activateTracking(other)).tracking_status, 'active');
});

test('completion stays atomic: of two racing completions exactly one wins, and gets its id back', { skip: skipWithoutPg() }, async (t) => {
  const { h, rc } = await setup(t);
  const id = await addRoute(h, { completion_blocked_reason: 'OUTSIDE_COMPLETION_RADIUS' });
  const done = { latitude: 32.9, longitude: -96.8, distanceMeters: 804.7, reason: 'Auto-completed: test' };

  const results = await Promise.all([rc.completeRouteAssignment(id, done), rc.completeRouteAssignment(id, done)]);
  assert.deepEqual(results.filter(Boolean), [{ id }], 'one winner, and only its id comes back');
  assert.equal(await rc.completeRouteAssignment(id, done), null, 'a later attempt finds nothing to complete');

  const row = await routeById(h, id);
  assert.equal(row.status, 'completed');
  assert.ok(row.completed_at);
  assert.deepEqual([row.completion_latitude, row.completion_distance_meters, row.completion_reason],
    [32.9, 804.7, 'Auto-completed: test']);
  assert.equal(row.completion_blocked_reason, null);
});

test("a route with no stored unit reads its driver profile's unit, one column", { skip: skipWithoutPg() }, async (t) => {
  const { h, rc } = await setup(t);
  const withProfile = await addGroup(h, 'WENZE UNIT 777 TEST DRIVER');
  const withoutProfile = await addGroup(h, 'SOME OTHER GROUP');
  await h.query("INSERT INTO driver_profiles (group_id, unit_number) VALUES ($1, '777')", [withProfile]);
  assert.equal(await rc.getProfileUnitNumberForGroup(withProfile), '777');
  assert.equal(await rc.getProfileUnitNumberForGroup(withoutProfile), null);
});

test('the GMaps settings read names only columns the table has, and every field round-trips', { skip: skipWithoutPg() }, async (t) => {
  const { gmaps } = await setup(t);
  const fresh = await gmaps.getGmapsConfig();
  assert.deepEqual(
    [fresh.enabled, fresh.routesApiEnabled, fresh.roadsApiEnabled, fresh.geocodingApiEnabled,
      fresh.deviationThresholdMeters, fresh.checkIntervalSeconds, fresh.offRouteGraceChecks,
      fresh.warningCooldownMinutes, fresh.staleGpsMinutes, fresh.parkedSpeedMph, fresh.routeCompletionRadiusMiles],
    [false, true, false, false, 250, 300, 3, 30, 15, 5, 50],
    'the shipped defaults'
  );
  assert.ok(fresh.updatedAt instanceof Date);

  const view = await gmaps.updateGmapsSettings({
    enabled: true, serverApiKey: 'AIzaTestKey0000', routesApiEnabled: false, roadsApiEnabled: true,
    geocodingApiEnabled: true, geocodingApiKey: 'AIzaGeoKey1111', deviationThresholdMeters: 400,
    checkIntervalSeconds: 120, offRouteGraceChecks: 5, warningCooldownMinutes: 45, staleGpsMinutes: 20,
    parkedSpeedMph: 7, routeCompletionRadiusMiles: 25,
  });
  const cfg = await gmaps.getGmapsConfig();
  assert.equal(cfg.serverApiKey, 'AIzaTestKey0000');
  assert.equal(cfg.geocodingApiKey, 'AIzaGeoKey1111');
  assert.equal(view.geocodingApiKeyMasked, '••••1111');
  assert.deepEqual(
    [cfg.enabled, cfg.routesApiEnabled, cfg.roadsApiEnabled, cfg.geocodingApiEnabled, cfg.deviationThresholdMeters,
      cfg.checkIntervalSeconds, cfg.offRouteGraceChecks, cfg.warningCooldownMinutes, cfg.staleGpsMinutes,
      cfg.parkedSpeedMph, cfg.routeCompletionRadiusMiles],
    [true, false, true, true, 400, 120, 5, 45, 20, 7, 25]
  );
});
