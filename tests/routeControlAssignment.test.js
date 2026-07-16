/**
 * Route Control assignment lifecycle: assignRoute (manual entry + geometry),
 * the tracking-start modes (normalizeTrackingOptions / evaluateTrackingStart),
 * their activation during a monitor pass, and startTrackingNow.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadService, loadServiceWith, SETTINGS, NOW, assignment, offRoute,
} = require('./helpers/routeControlHarness');

const service = loadService();
const { evaluateAssignment } = service;

// ── assignRoute manual fallback ──

test('assignRoute with manual origin/destination computes geometry when GMaps is enabled', async () => {
  let computeArgs = null;
  const svc = loadServiceWith({
    '../database/gmapsSettings.js': {
      async getGmapsConfig() { return { enabled: true, routesApiEnabled: true, serverApiKey: 'k' }; },
    },
    '../services/googleMapsClient.js': {
      async computeRoute(args) {
        computeArgs = args;
        return { encodedPolyline: 'abc', distanceMeters: 1000, durationSeconds: 600 };
      },
    },
  });
  const result = await svc.assignRoute({
    groupId: 7,
    manual: { origin: 'Atlanta, GA', destination: 'Miami, FL', waypoints: ['Orlando, FL'] },
  });
  assert.equal(result.computed, true);
  assert.equal(result.geometryPending, false);
  assert.equal(computeArgs.origin.raw, 'Atlanta, GA');
  assert.equal(computeArgs.destination.raw, 'Miami, FL');
  assert.equal(computeArgs.waypoints[0].raw, 'Orlando, FL');
  assert.equal(result.assignment.encodedPolyline, 'abc');
});

test('assignRoute with manual origin/destination stores geometry pending when GMaps is disabled', async () => {
  const svc = loadServiceWith({
    '../database/gmapsSettings.js': { async getGmapsConfig() { return { enabled: false }; } },
    '../services/googleMapsClient.js': {
      async computeRoute() { throw new Error('should not be called when GMaps is disabled'); },
    },
  });
  const result = await svc.assignRoute({
    groupId: 7,
    manual: { origin: 'Atlanta, GA', destination: 'Miami, FL' },
  });
  assert.equal(result.computed, false);
  assert.equal(result.geometryPending, true);
  assert.equal(result.assignment.encodedPolyline, null);
});
// ── Tracking start controls ──────────────────────────────────────────────────

test('assignRoute (admin, no tracking options) defaults to pending / after_message_sent', async () => {
  let created = null;
  const svc = loadServiceWith({
    '../database/routeControl.js': {
      async createRouteAssignment(a) { created = a; return { id: 1, tracking_status: a.trackingStatus, tracking_start_mode: a.trackingStartMode }; },
      async insertRouteMonitorEvent() { return null; },
    },
  });
  const res = await svc.assignRoute({ groupId: 7, manual: { origin: 'A', destination: 'B' }, assignedBy: 'admin' });
  assert.equal(created.trackingStatus, 'pending');
  assert.equal(created.trackingStartMode, 'after_message_sent');
  assert.equal(created.trackingHoldReason, 'waiting_for_message');
  assert.equal(res.trackingStatus, 'pending');
});

test('assignRoute from Telegram keeps the legacy immediate start', async () => {
  let created = null;
  const svc = loadServiceWith({
    '../database/routeControl.js': {
      async createRouteAssignment(a) { created = a; return { id: 1 }; },
      async insertRouteMonitorEvent() { return null; },
    },
  });
  await svc.assignRoute({
    groupId: 7, manual: { origin: 'A', destination: 'B' }, assignedBy: 'disp', source: 'telegram',
  });
  assert.equal(created.trackingStatus, 'active');
  assert.equal(created.trackingStartMode, 'immediate');
});

test('assignRoute with explicit immediate mode starts active', async () => {
  let created = null;
  const svc = loadServiceWith({
    '../database/routeControl.js': {
      async createRouteAssignment(a) { created = a; return { id: 1 }; },
      async insertRouteMonitorEvent() { return null; },
    },
  });
  await svc.assignRoute({
    groupId: 7, manual: { origin: 'A', destination: 'B' }, tracking: { startMode: 'immediate' },
  });
  assert.equal(created.trackingStatus, 'active');
  assert.equal(created.trackingHoldReason, null);
});

test('assignRoute scheduled_time requires a valid time and stores it', async () => {
  let created = null;
  const svc = loadServiceWith({
    '../database/routeControl.js': {
      async createRouteAssignment(a) { created = a; return { id: 1 }; },
      async insertRouteMonitorEvent() { return null; },
    },
  });
  await assert.rejects(
    () => svc.assignRoute({ groupId: 7, manual: { origin: 'A', destination: 'B' }, tracking: { startMode: 'scheduled_time' } }),
    (err) => { assert.equal(err.code, 'BAD_TRACKING_TIME'); return true; }
  );
  await svc.assignRoute({
    groupId: 7, manual: { origin: 'A', destination: 'B' },
    tracking: { startMode: 'scheduled_time', startAt: '2026-08-01T15:00:00Z' },
  });
  assert.equal(created.trackingStatus, 'pending');
  assert.equal(created.trackingStartAt, '2026-08-01T15:00:00.000Z');
  assert.equal(created.trackingHoldReason, 'waiting_for_time');
});

test('assignRoute start_location parses lat,lng, applies the default radius, and rejects plain addresses', async () => {
  let created = null;
  const svc = loadServiceWith({
    '../database/routeControl.js': {
      async createRouteAssignment(a) { created = a; return { id: 1 }; },
      async insertRouteMonitorEvent() { return null; },
    },
  });
  await assert.rejects(
    () => svc.assignRoute({
      groupId: 7, manual: { origin: 'A', destination: 'B' },
      tracking: { startMode: 'start_location', startLocation: 'Monteagle, TN' },
    }),
    (err) => { assert.equal(err.code, 'START_LOCATION_NEEDS_COORDS'); return true; }
  );
  await svc.assignRoute({
    groupId: 7, manual: { origin: 'A', destination: 'B' },
    tracking: { startMode: 'start_location', startLocation: '35.2331, -85.7095', startRadiusMiles: 900 },
  });
  assert.equal(created.trackingStatus, 'pending');
  assert.equal(created.trackingStartLat, 35.2331);
  assert.equal(created.trackingStartLng, -85.7095);
  assert.equal(created.trackingStartRadiusMiles, 100, 'radius is clamped');
  assert.equal(created.trackingHoldReason, 'waiting_for_location');
});

test('assignRoute rejects an unknown tracking mode', async () => {
  const svc = loadServiceWith({});
  await assert.rejects(
    () => svc.assignRoute({ groupId: 7, manual: { origin: 'A', destination: 'B' }, tracking: { startMode: 'whenever' } }),
    (err) => { assert.equal(err.code, 'BAD_TRACKING_MODE'); return true; }
  );
});

test('evaluateTrackingStart: after_message_sent waits for the send, then starts', () => {
  const base = { tracking_status: 'pending', tracking_start_mode: 'after_message_sent' };
  const waiting = service.evaluateTrackingStart({ assignment: { ...base, driver_group_message_sent_at: null } });
  assert.equal(waiting.shouldStart, false);
  assert.equal(waiting.holdReason, 'waiting_for_message');
  const started = service.evaluateTrackingStart({ assignment: { ...base, driver_group_message_sent_at: '2026-07-07T11:00:00Z' } });
  assert.equal(started.shouldStart, true);
});

test('evaluateTrackingStart: scheduled_time starts only once the time passes', () => {
  const base = { tracking_status: 'pending', tracking_start_mode: 'scheduled_time', tracking_start_at: '2026-07-07T13:00:00Z' };
  const early = service.evaluateTrackingStart({ assignment: base, now: new Date('2026-07-07T12:59:00Z') });
  assert.equal(early.shouldStart, false);
  assert.equal(early.holdReason, 'waiting_for_time');
  const due = service.evaluateTrackingStart({ assignment: base, now: new Date('2026-07-07T13:00:01Z') });
  assert.equal(due.shouldStart, true);
});

test('evaluateTrackingStart: start_location starts only inside the radius', () => {
  const base = {
    tracking_status: 'pending', tracking_start_mode: 'start_location',
    tracking_start_lat: 35.2331, tracking_start_lng: -85.7095, tracking_start_radius_miles: 2,
  };
  const noGps = service.evaluateTrackingStart({ assignment: base, location: null });
  assert.equal(noGps.shouldStart, false);
  assert.equal(noGps.holdReason, 'waiting_for_location');
  const far = service.evaluateTrackingStart({
    assignment: base, location: { latitude: 36.2, longitude: -86.7 },
  });
  assert.equal(far.shouldStart, false);
  const near = service.evaluateTrackingStart({
    assignment: base, location: { latitude: 35.24, longitude: -85.71 },
  });
  assert.equal(near.shouldStart, true);
});

test('evaluateAssignment skips deviation checks while tracking is pending', () => {
  const verdict = evaluateAssignment({
    assignment: assignment({ tracking_status: 'pending' }),
    location: offRoute, settings: SETTINGS, now: NOW,
  });
  assert.equal(verdict.result, 'not_monitored');
  assert.match(verdict.reason, /not started/);
});

test('runRouteMonitorCheck activates a pending route once its message was sent', async () => {
  const events = [];
  let activatedId = null;
  const svc = loadServiceWith({
    '../database/gmapsSettings.js': {
      async getGmapsConfig() {
        return {
          enabled: true, deviationThresholdMeters: 250, offRouteGraceChecks: 3,
          warningCooldownMinutes: 30, staleGpsMinutes: 15, parkedSpeedMph: 5, checkIntervalSeconds: 300,
        };
      },
    },
    '../database/routeControl.js': {
      async listActiveAssignmentsForMonitor() {
        return [{
          id: 11, status: 'active', tracking_status: 'pending',
          tracking_start_mode: 'after_message_sent',
          driver_group_message_sent_at: '2026-07-07T11:00:00Z',
          group_name: 'G', telegram_group_id: -1,
        }];
      },
      async activateTracking(id) { activatedId = id; return { id }; },
      async setTrackingHoldReason() { throw new Error('should not be called'); },
      async insertRouteMonitorEvent(e) { events.push(e); return e; },
      async updateRouteAssignmentMonitorState() { return null; },
      async updateCompletionDiagnostics() { return null; },
    },
  });
  const res = await svc.runRouteMonitorCheck(null, { now: NOW });
  assert.equal(activatedId, 11);
  assert.equal(res.activated, 1);
  assert.equal(events[0].eventType, 'tracking_started');
});

test('runRouteMonitorCheck records a hold-reason event once, not on every tick', async () => {
  const events = [];
  let holdSet = null;
  const rcMock = {
    async listActiveAssignmentsForMonitor() {
      return [{
        id: 12, status: 'active', tracking_status: 'pending',
        tracking_start_mode: 'scheduled_time', tracking_start_at: '2027-01-01T00:00:00Z',
        tracking_hold_reason: null, group_name: 'G', telegram_group_id: -1,
      }];
    },
    async activateTracking() { throw new Error('should not activate'); },
    async setTrackingHoldReason(id, reason) { holdSet = { id, reason }; return { id }; },
    async insertRouteMonitorEvent(e) { events.push(e); return e; },
    async updateRouteAssignmentMonitorState() { return null; },
    async updateCompletionDiagnostics() { return null; },
  };
  const gmapsMock = {
    async getGmapsConfig() {
      return {
        enabled: true, deviationThresholdMeters: 250, offRouteGraceChecks: 3,
        warningCooldownMinutes: 30, staleGpsMinutes: 15, parkedSpeedMph: 5, checkIntervalSeconds: 300,
      };
    },
  };
  const svc = loadServiceWith({
    '../database/gmapsSettings.js': gmapsMock,
    '../database/routeControl.js': rcMock,
  });
  await svc.runRouteMonitorCheck(null, { now: NOW });
  assert.deepEqual(holdSet, { id: 12, reason: 'waiting_for_time' });
  assert.equal(events[0].eventType, 'tracking_start_waiting_for_time');

  // Second tick with the SAME hold reason already stored → no new event.
  events.length = 0; holdSet = null;
  const svc2 = loadServiceWith({
    '../database/gmapsSettings.js': gmapsMock,
    '../database/routeControl.js': {
      ...rcMock,
      async listActiveAssignmentsForMonitor() {
        return [{
          id: 12, status: 'active', tracking_status: 'pending',
          tracking_start_mode: 'scheduled_time', tracking_start_at: '2027-01-01T00:00:00Z',
          tracking_hold_reason: 'waiting_for_time', group_name: 'G', telegram_group_id: -1,
        }];
      },
    },
  });
  await svc2.runRouteMonitorCheck(null, { now: NOW });
  assert.equal(holdSet, null, 'hold reason unchanged — not rewritten');
  assert.equal(events.length, 0, 'no repeat event spam');
});

test('runRouteMonitorCheck activates a start-location route when GPS enters the radius', async () => {
  const events = [];
  let activatedId = null;
  const svc = loadServiceWith({
    '../database/gmapsSettings.js': {
      async getGmapsConfig() {
        return {
          enabled: true, deviationThresholdMeters: 250, offRouteGraceChecks: 3,
          warningCooldownMinutes: 30, staleGpsMinutes: 15, parkedSpeedMph: 5, checkIntervalSeconds: 300,
        };
      },
    },
    '../services/liveLocationResolver.js': {
      async resolveLiveLocationForGroupTitle() {
        return { location: { latitude: 35.235, longitude: -85.71 } };
      },
    },
    '../database/routeControl.js': {
      async listActiveAssignmentsForMonitor() {
        return [{
          id: 13, status: 'active', tracking_status: 'pending',
          tracking_start_mode: 'start_location',
          tracking_start_lat: 35.2331, tracking_start_lng: -85.7095, tracking_start_radius_miles: 2,
          group_name: 'G', telegram_group_id: -1,
        }];
      },
      async activateTracking(id) { activatedId = id; return { id }; },
      async setTrackingHoldReason() { return null; },
      async insertRouteMonitorEvent(e) { events.push(e); return e; },
      async updateRouteAssignmentMonitorState() { return null; },
      async updateCompletionDiagnostics() { return null; },
    },
  });
  const res = await svc.runRouteMonitorCheck(null, { now: NOW });
  assert.equal(activatedId, 13);
  assert.equal(res.activated, 1);
  assert.equal(events[0].eventType, 'tracking_started');
});
test('startTrackingNow activates a pending route and refuses non-active lifecycles', async () => {
  const events = [];
  let activated = null;
  const svc = loadServiceWith({
    '../database/routeControl.js': {
      async getRouteAssignment(id) {
        return id === 1
          ? { id: 1, status: 'active', tracking_status: 'pending' }
          : { id: 2, status: 'cancelled', tracking_status: 'pending' };
      },
      async activateTracking(id) { activated = id; return { id, tracking_status: 'active' }; },
      async insertRouteMonitorEvent(e) { events.push(e); return e; },
    },
  });
  const res = await svc.startTrackingNow(1, 'admin');
  assert.equal(res.alreadyActive, false);
  assert.equal(activated, 1);
  assert.equal(events[0].eventType, 'tracking_started');
  await assert.rejects(() => svc.startTrackingNow(2), (err) => {
    assert.equal(err.code, 'NOT_ACTIVE'); return true;
  });
});
