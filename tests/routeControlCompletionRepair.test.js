/**
 * Destination auto-completion across EXISTING routes: pending-tracking routes,
 * the "completion needs no Google Maps" gate, GPS resolution by stored unit,
 * bounded destination-coordinate repair (polyline self-heal, text parse,
 * geocoding), and the admin "Run completion check now" action.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadService, loadServiceWith, POLYLINE, NOW } = require('./helpers/routeControlHarness');
const {
  pointMilesFromDest, loadServiceForCompletion, NEAR_DEST_OFF_ROUTE,
} = require('./helpers/routeControlCompletionHarness');

const service = loadService();

// ── Existing routes / pending tracking / feature-gate completion ─────────────

test('runRouteMonitorCheck completes a tracking-PENDING route silently (no activation, no warning)', async () => {
  const { svc, telegram, captured } = loadServiceForCompletion({
    assignments: [{
      id: 30, status: 'active', tracking_status: 'pending',
      tracking_start_mode: 'after_message_sent', driver_group_message_sent_at: null,
      encoded_polyline: null, destination_lat: 40, destination_lng: -100,
      group_name: 'G', telegram_group_id: -100600,
    }],
    location: pointMilesFromDest(30),
  });
  const res = await svc.runRouteMonitorCheck(telegram, { now: NOW });
  assert.equal(res.completed, 1, 'pending route inside the completion radius completes');
  assert.equal(captured.activated.length, 0, 'tracking is never activated for it');
  assert.equal(captured.telegramSends.length, 0, 'no message of any kind');
  assert.equal(captured.events.length, 1);
  assert.equal(captured.events[0].eventType, 'destination_reached');
});

test('runRouteMonitorCheck leaves a far-away pending route pending, with zero warnings', async () => {
  const { svc, telegram, captured } = loadServiceForCompletion({
    assignments: [{
      id: 31, status: 'active', tracking_status: 'pending',
      tracking_start_mode: 'after_message_sent', driver_group_message_sent_at: null,
      tracking_hold_reason: 'waiting_for_message',
      encoded_polyline: POLYLINE, destination_lat: 40, destination_lng: -100,
      consecutive_off_route: 5, // even a long off-route streak must not warn while pending
      group_name: 'G', telegram_group_id: -100601,
    }],
    location: pointMilesFromDest(200),
  });
  const res = await svc.runRouteMonitorCheck(telegram, { now: NOW });
  assert.equal(res.completed, 0);
  assert.equal(res.notified, 0);
  assert.equal(captured.activated.length, 0, 'stays pending');
  assert.equal(captured.telegramSends.length, 0, 'pending routes NEVER get off-route warnings');
  assert.equal(captured.diagnostics[0].blockedReason, 'OUTSIDE_COMPLETION_RADIUS');
});

test('runRouteMonitorCheck completes routes even when Google Maps is DISABLED', async () => {
  const { svc, telegram, captured } = loadServiceForCompletion({
    gmapsEnabled: false,
    assignments: [{
      id: 32, status: 'active', tracking_status: 'active',
      encoded_polyline: POLYLINE, destination_lat: 40, destination_lng: -100,
      group_name: 'G', telegram_group_id: -100602,
    }],
    location: pointMilesFromDest(12),
  });
  const res = await svc.runRouteMonitorCheck(telegram, { now: NOW });
  assert.equal(res.enabled, false, 'off-route monitoring reported as disabled');
  assert.equal(res.completed, 1, 'completion does not need the Google gate');
  assert.equal(res.checked, 0, 'no off-route evaluation while GMaps is off');
  assert.equal(captured.telegramSends.length, 0);
});

test('runRouteMonitorCheck still completes when the settings row is unavailable (default 50 mi)', async () => {
  const { svc, telegram, captured } = loadServiceForCompletion({
    gmapsThrows: true,
    assignments: [{
      id: 33, status: 'active', tracking_status: 'active',
      encoded_polyline: null, destination_lat: 40, destination_lng: -100,
      group_name: 'G', telegram_group_id: -100603,
    }],
    location: pointMilesFromDest(30),
  });
  const res = await svc.runRouteMonitorCheck(telegram, { now: NOW });
  assert.equal(res.completed, 1, '30 mi completes under the built-in 50 mi default');
  assert.equal(captured.telegramSends.length, 0);
});

test('runRouteMonitorCheck resolves GPS by the STORED unit number, not only the group title', async () => {
  const resolverCapture = [];
  const { svc, telegram } = loadServiceForCompletion({
    resolverCapture,
    assignments: [{
      id: 34, status: 'active', tracking_status: 'active', unit_number: '512',
      encoded_polyline: null, destination_lat: 40, destination_lng: -100,
      group_name: 'Group with no unit in the title', telegram_group_id: -100604,
    }],
    location: pointMilesFromDest(5),
  });
  await svc.runRouteMonitorCheck(telegram, { now: NOW });
  assert.equal(resolverCapture.length, 1);
  assert.equal(resolverCapture[0].opts.unitNumber, '512');
});

test('runRouteMonitorCheck never completes on an ambiguous unit — diagnostic recorded instead', async () => {
  const { svc, telegram, captured } = loadServiceForCompletion({
    resolverThrows: 'AMBIGUOUS_UNIT_MATCH',
    assignments: [{
      id: 35, status: 'active', tracking_status: 'active',
      encoded_polyline: null, destination_lat: 40, destination_lng: -100,
      group_name: 'G', telegram_group_id: -100605,
    }],
    location: pointMilesFromDest(2), // irrelevant — resolution fails first
  });
  const res = await svc.runRouteMonitorCheck(telegram, { now: NOW });
  assert.equal(res.completed, 0);
  assert.equal(captured.completed.length, 0);
  assert.equal(captured.diagnostics[0].blockedReason, 'UNIT_RESOLUTION_FAILED');
  assert.equal(captured.telegramSends.length, 0);
});

test('runRouteMonitorCheck repairs coordinate-text destinations and completes in the same pass', async () => {
  let storedCoords = null;
  const { svc, telegram, captured } = loadServiceForCompletion({
    assignments: [{
      id: 36, status: 'active', tracking_status: 'active',
      encoded_polyline: null,
      destination_lat: null, destination_lng: null,
      destination_text: '40, -100', // parseable coordinates — free repair, no geocoding
      destination_repair_attempts: 0,
      group_name: 'G', telegram_group_id: -100606,
    }],
    location: pointMilesFromDest(10),
    extraRcMock: {
      async setRouteAssignmentDestinationCoords(id, coords) { storedCoords = { id, ...coords }; return { id }; },
    },
  });
  const res = await svc.runRouteMonitorCheck(telegram, { now: NOW });
  assert.deepEqual(storedCoords, { id: 36, lat: 40, lng: -100 });
  assert.equal(res.completed, 1, 'repaired destination completes immediately');
  assert.ok(captured.events.some((e) => e.eventType === 'destination_repaired'));
});

test('destinationCoordFromPolyline returns the LAST route point (the destination), null for empty', () => {
  // POLYLINE decodes to [[38.5,-120.2],[40.7,-120.95],[43.252,-126.453]].
  const d = service.destinationCoordFromPolyline(POLYLINE);
  assert.ok(d && Math.abs(d.lat - 43.252) < 1e-6 && Math.abs(d.lng - (-126.453)) < 1e-6);
  assert.equal(service.destinationCoordFromPolyline(''), null);
  assert.equal(service.destinationCoordFromPolyline(null), null);
});

test('assignRoute captures the FINAL destination coords from the computed polyline for an address destination', async () => {
  let created = null;
  const svc = loadServiceWith({
    '../database/gmapsSettings.js': {
      async getGmapsConfig() { return { enabled: true, routesApiEnabled: true, serverApiKey: 'k' }; },
    },
    '../services/googleMapsClient.js': {
      async computeRoute() { return { encodedPolyline: POLYLINE, distanceMeters: 1000, durationSeconds: 60 }; },
    },
    '../database/routeControl.js': {
      async createRouteAssignment(a) { created = a; return { id: 1, ...a }; },
      async insertRouteMonitorEvent() { return null; },
    },
  });
  // An address-only destination classifies to NO coordinates — the fix backfills
  // the destination from the polyline END so auto-completion has a target.
  await svc.assignRoute({
    groupId: 7, manual: { origin: 'Chicago, IL', destination: 'Dallas, TX' },
    tracking: { startMode: 'immediate' },
  });
  assert.ok(Math.abs(created.destinationLat - 43.252) < 1e-6, 'destination lat from polyline end');
  assert.ok(Math.abs(created.destinationLng - (-126.453)) < 1e-6, 'destination lng from polyline end');
});

test('assignRoute keeps EXPLICIT destination coordinates (never overwrites them with the polyline end)', async () => {
  let created = null;
  const svc = loadServiceWith({
    '../database/gmapsSettings.js': {
      async getGmapsConfig() { return { enabled: true, routesApiEnabled: true, serverApiKey: 'k' }; },
    },
    '../services/googleMapsClient.js': {
      async computeRoute() { return { encodedPolyline: POLYLINE }; },
    },
    '../database/routeControl.js': {
      async createRouteAssignment(a) { created = a; return { id: 1, ...a }; },
      async insertRouteMonitorEvent() { return null; },
    },
  });
  await svc.assignRoute({
    groupId: 7, manual: { origin: '41.0, -87.0', destination: '32.9, -96.8' },
    tracking: { startMode: 'immediate' },
  });
  assert.equal(created.destinationLat, 32.9, 'explicit destination lat preserved');
  assert.equal(created.destinationLng, -96.8, 'explicit destination lng preserved');
});

test('runRouteMonitorCheck self-heals an EXISTING route from its polyline end (no geocoding) and completes', async () => {
  // Simulates an active route created before the fix: it has geometry but NULL
  // destination coordinates. The monitor recovers the destination from the
  // polyline end on the next pass — the deploy/restart reconciliation path.
  let storedCoords = null;
  const { svc, telegram, captured } = loadServiceForCompletion({
    assignments: [{
      id: 40, status: 'active', tracking_status: 'active',
      encoded_polyline: POLYLINE,
      destination_lat: null, destination_lng: null,
      group_name: 'G', telegram_group_id: -100700,
    }],
    // Driver sitting exactly at the polyline end (the true destination).
    location: { latitude: 43.252, longitude: -126.453, speedMilesPerHour: 0, pingAgeMinutes: 1 },
    extraRcMock: {
      async setRouteAssignmentDestinationCoords(id, coords) { storedCoords = { id, ...coords }; return { id }; },
    },
  });
  const res = await svc.runRouteMonitorCheck(telegram, { now: NOW });
  assert.ok(
    storedCoords && Math.abs(storedCoords.lat - 43.252) < 1e-6 && Math.abs(storedCoords.lng - (-126.453)) < 1e-6,
    'destination coordinates recovered from the polyline'
  );
  assert.equal(res.completed, 1, 'route completes once the destination is recovered — no geocoding needed');
  assert.ok(
    captured.events.some((e) => e.eventType === 'destination_repaired' && /polyline/i.test(e.detail || '')),
    'records a polyline-based repair event'
  );
  assert.equal(captured.telegramSends.length, 0, 'completion is silent');
});

test('destination repair via geocoding is BOUNDED — never retried when attempts are exhausted', async () => {
  let geocodeCalls = 0;
  const svc = loadServiceWith({
    '../database/gmapsSettings.js': {
      async getGmapsConfig() { return { enabled: false, staleGpsMinutes: 15, routeCompletionRadiusMiles: 50 }; },
    },
    '../services/liveLocationResolver.js': {
      async resolveLiveLocationForGroupTitle() { return { location: pointMilesFromDest(300) }; },
    },
    '../services/etaRoutingService.js': {
      async geocodePlace() { geocodeCalls += 1; return null; },
    },
    '../database/routeControl.js': {
      async listActiveAssignmentsForMonitor() {
        return [{
          id: 37, status: 'active', tracking_status: 'active',
          encoded_polyline: null, destination_lat: null, destination_lng: null,
          destination_text: 'Dallas, TX',
          destination_repair_attempts: 3, // exhausted
          group_name: 'G', telegram_group_id: -1,
        }];
      },
      async updateCompletionDiagnostics() { return null; },
      async insertRouteMonitorEvent() { return null; },
      async recordDestinationRepairAttempt() { return null; },
      async setRouteAssignmentDestinationCoords() { throw new Error('must not store anything'); },
    },
  });
  await svc.runRouteMonitorCheck(null, { now: NOW });
  assert.equal(geocodeCalls, 0, 'no geocode call once the attempt budget is used up');
});

test('destination repair geocodes text destinations (bounded) and stores the result', async () => {
  let stored = null;
  let attempts = 0;
  const svc = loadServiceWith({
    '../database/gmapsSettings.js': {
      async getGmapsConfig() { return { enabled: false, staleGpsMinutes: 15, routeCompletionRadiusMiles: 50 }; },
    },
    '../services/liveLocationResolver.js': {
      async resolveLiveLocationForGroupTitle() { return { location: pointMilesFromDest(20) }; },
    },
    '../services/etaRoutingService.js': {
      async geocodePlace(text) { return text === 'Dallas, TX' ? { latitude: 40, longitude: -100 } : null; },
    },
    '../database/routeControl.js': {
      async listActiveAssignmentsForMonitor() {
        return [{
          id: 38, status: 'active', tracking_status: 'active',
          encoded_polyline: null, destination_lat: null, destination_lng: null,
          destination_text: 'Dallas, TX', destination_repair_attempts: 0, destination_repair_last_at: null,
          group_name: 'G', telegram_group_id: -1,
        }];
      },
      async recordDestinationRepairAttempt(id) { attempts += 1; return { id }; },
      async setRouteAssignmentDestinationCoords(id, coords) { stored = { id, ...coords }; return { id }; },
      async completeRouteAssignment(id, data) { return { id, status: 'completed', ...data }; },
      async insertRouteMonitorEvent() { return null; },
      async updateCompletionDiagnostics() { return null; },
    },
  });
  const res = await svc.runRouteMonitorCheck(null, { now: NOW });
  assert.equal(attempts, 1);
  assert.deepEqual(stored, { id: 38, lat: 40, lng: -100 });
  assert.equal(res.completed, 1, 'geocoded destination lets the 20-mi route complete');
});

// ── runCompletionCheckNow (admin "Run completion check now") ─────────────────

test('runCompletionCheckNow completes one route and reports the distance', async () => {
  const { svc, captured } = loadServiceForCompletion({
    assignments: [], // list not used for the single-route path
    location: pointMilesFromDest(31.8),
    extraRcMock: {
      async getRouteAssignment(id) {
        return {
          id, status: 'active', tracking_status: 'pending',
          destination_lat: 40, destination_lng: -100,
          group_name: 'G', telegram_group_id: -1,
        };
      },
    },
  });
  const out = await svc.runCompletionCheckNow({ assignmentId: 44, now: NOW });
  assert.equal(out.completionRadiusMiles, 50);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].completed, true);
  assert.ok(Math.abs(out.results[0].distanceMiles - 31.8) < 0.1);
  assert.equal(captured.completed[0].id, 44);
});

test('runCompletionCheckNow reports (not completes) a non-active route and sends nothing', async () => {
  const { svc, captured } = loadServiceForCompletion({
    assignments: [],
    location: pointMilesFromDest(1),
    extraRcMock: {
      async getRouteAssignment(id) { return { id, status: 'completed', group_name: 'G' }; },
    },
  });
  const out = await svc.runCompletionCheckNow({ assignmentId: 45, now: NOW });
  assert.equal(out.results[0].completed, false);
  assert.match(out.results[0].note, /completed/);
  assert.equal(captured.completed.length, 0);
  assert.equal(captured.telegramSends.length, 0);
});

test('runCompletionCheckNow sweeps all active routes and NEVER warns or activates tracking', async () => {
  const { svc, captured } = loadServiceForCompletion({
    assignments: [
      {
        id: 46, status: 'active', tracking_status: 'active',
        encoded_polyline: POLYLINE, destination_lat: 40, destination_lng: -100,
        consecutive_off_route: 5, group_name: 'A', telegram_group_id: -1,
      },
      {
        id: 47, status: 'active', tracking_status: 'pending',
        tracking_start_mode: 'immediate',
        destination_lat: 40, destination_lng: -100, group_name: 'B', telegram_group_id: -2,
      },
    ],
    location: pointMilesFromDest(200), // both far away
  });
  const out = await svc.runCompletionCheckNow({ now: NOW });
  assert.equal(out.results.length, 2);
  assert.ok(out.results.every((r) => r.completed === false));
  assert.ok(out.results.every((r) => r.blockedReason === 'OUTSIDE_COMPLETION_RADIUS'));
  assert.equal(captured.telegramSends.length, 0, 'no warnings from the reconciliation pass');
  assert.equal(captured.activated.length, 0, 'tracking state untouched');
});
