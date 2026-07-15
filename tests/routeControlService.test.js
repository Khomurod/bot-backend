const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * Load routeControlService with its DB / Google / telegram / resolver deps
 * stubbed via require.cache, so the PURE decision logic (evaluateAssignment) and
 * link parsing can be tested without env, network, or a database.
 */
function loadService() {
  const servicePath = path.resolve(__dirname, '../services/routeControlService.js');
  const stubs = {
    '../database/db.js': {},
    '../database/routeControl.js': {},
    '../database/gmapsSettings.js': { async getGmapsConfig() { return {}; } },
    '../services/googleMapsClient.js': {},
    '../services/liveLocationResolver.js': { async resolveLiveLocationForGroupTitle() { return { location: null }; } },
    '../services/telegramHtml.js': { safeSend: async (fn) => fn() },
  };
  delete require.cache[servicePath];
  for (const [rel, exports] of Object.entries(stubs)) {
    require.cache[path.resolve(__dirname, rel)] = { exports };
  }
  return require(servicePath);
}

/**
 * Load the service with custom stubs for the modules a test cares about (merged
 * over sensible defaults). Returns a fresh service instance bound to the stubs.
 */
function loadServiceWith(overrides = {}) {
  const servicePath = path.resolve(__dirname, '../services/routeControlService.js');
  const stubs = {
    '../database/db.js': { async getDriverProfileByGroupId() { return null; } },
    '../database/routeControl.js': {
      async createRouteAssignment(a) { return { id: 1, ...a }; },
      async insertRouteMonitorEvent() { return null; },
    },
    '../database/gmapsSettings.js': { async getGmapsConfig() { return {}; } },
    '../services/googleMapsClient.js': {},
    '../services/liveLocationResolver.js': { async resolveLiveLocationForGroupTitle() { return { location: null }; } },
    '../services/telegramHtml.js': { safeSend: async (fn) => fn() },
    ...overrides,
  };
  delete require.cache[servicePath];
  for (const [rel, exports] of Object.entries(stubs)) {
    require.cache[path.resolve(__dirname, rel)] = { exports };
  }
  return require(servicePath);
}

const service = loadService();
const { evaluateAssignment } = service;

// Google's canonical polyline: [[38.5,-120.2],[40.7,-120.95],[43.252,-126.453]].
const POLYLINE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const SETTINGS = {
  deviationThresholdMeters: 250,
  offRouteGraceChecks: 3,
  warningCooldownMinutes: 30,
  staleGpsMinutes: 15,
  parkedSpeedMph: 5,
};
const NOW = new Date('2026-07-07T12:00:00Z');

function assignment(overrides = {}) {
  return {
    status: 'active',
    encoded_polyline: POLYLINE,
    consecutive_off_route: 0,
    last_notification_at: null,
    ...overrides,
  };
}
// On the route (first vertex) vs far off it (~1.2° east), both fresh + moving.
const onRoute = {
  latitude: 38.5, longitude: -120.2, speedMilesPerHour: 60, pingAgeMinutes: 1,
};
const offRoute = {
  latitude: 38.5, longitude: -119.0, speedMilesPerHour: 60, pingAgeMinutes: 1,
};

test('on-route ping → on_route, streak reset, no warning', () => {
  const v = evaluateAssignment({
    assignment: assignment({ consecutive_off_route: 2 }), location: onRoute, settings: SETTINGS, now: NOW,
  });
  assert.equal(v.result, 'on_route');
  assert.ok(v.deviationMeters < 250);
  assert.equal(v.consecutiveOffRoute, 0);
  assert.equal(v.shouldNotify, false);
});

test('off-route distance is measured and exceeds the threshold', () => {
  const v = evaluateAssignment({
    assignment: assignment(), location: offRoute, settings: SETTINGS, now: NOW,
  });
  assert.equal(v.result, 'off_route');
  assert.ok(v.deviationMeters > SETTINGS.deviationThresholdMeters);
});

test('one bad ping does not warn — grace threshold must be reached first', () => {
  const first = evaluateAssignment({
    assignment: assignment({ consecutive_off_route: 0 }), location: offRoute, settings: SETTINGS, now: NOW,
  });
  assert.equal(first.consecutiveOffRoute, 1);
  assert.equal(first.shouldNotify, false);

  const second = evaluateAssignment({
    assignment: assignment({ consecutive_off_route: 1 }), location: offRoute, settings: SETTINGS, now: NOW,
  });
  assert.equal(second.consecutiveOffRoute, 2);
  assert.equal(second.shouldNotify, false);

  const third = evaluateAssignment({
    assignment: assignment({ consecutive_off_route: 2 }), location: offRoute, settings: SETTINGS, now: NOW,
  });
  assert.equal(third.consecutiveOffRoute, 3); // reached grace
  assert.equal(third.shouldNotify, true);
});

test('notification cooldown prevents spamming warnings', () => {
  const recent = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString(); // 10 min ago
  const withinCooldown = evaluateAssignment({
    assignment: assignment({ consecutive_off_route: 2, last_notification_at: recent }),
    location: offRoute, settings: SETTINGS, now: NOW,
  });
  assert.equal(withinCooldown.result, 'off_route');
  assert.equal(withinCooldown.shouldNotify, false);

  const old = new Date(NOW.getTime() - 40 * 60 * 1000).toISOString(); // 40 min ago > cooldown
  const afterCooldown = evaluateAssignment({
    assignment: assignment({ consecutive_off_route: 2, last_notification_at: old }),
    location: offRoute, settings: SETTINGS, now: NOW,
  });
  assert.equal(afterCooldown.shouldNotify, true);
});

test('stale GPS never warns (logged as stale)', () => {
  const v = evaluateAssignment({
    assignment: assignment({ consecutive_off_route: 2 }),
    location: { ...offRoute, pingAgeMinutes: 40 }, settings: SETTINGS, now: NOW,
  });
  assert.equal(v.result, 'stale');
  assert.equal(v.shouldNotify, false);
  assert.equal(v.consecutiveOffRoute, 2); // streak unchanged
});

test('missing GPS is not_checked, never a warning', () => {
  const v = evaluateAssignment({
    assignment: assignment({ consecutive_off_route: 2 }), location: null, settings: SETTINGS, now: NOW,
  });
  assert.equal(v.result, 'not_checked');
  assert.equal(v.shouldNotify, false);
});

test('off-route but parked/slow does not escalate', () => {
  const v = evaluateAssignment({
    assignment: assignment({ consecutive_off_route: 2 }),
    location: { ...offRoute, speedMilesPerHour: 2 }, settings: SETTINGS, now: NOW,
  });
  assert.equal(v.result, 'parked');
  assert.equal(v.shouldNotify, false);
  assert.equal(v.consecutiveOffRoute, 2);
});

test('completed and cancelled routes are not monitored', () => {
  for (const status of ['completed', 'cancelled']) {
    const v = evaluateAssignment({
      assignment: assignment({ status, consecutive_off_route: 2 }),
      location: offRoute, settings: SETTINGS, now: NOW,
    });
    assert.equal(v.result, 'not_monitored');
    assert.equal(v.shouldNotify, false);
  }
});

test('an assignment with no geometry is not monitored', () => {
  const v = evaluateAssignment({
    assignment: assignment({ encoded_polyline: null }), location: offRoute, settings: SETTINGS, now: NOW,
  });
  assert.equal(v.result, 'no_geometry');
  assert.equal(v.shouldNotify, false);
});

// ── parseRouteLink ──

test('parseRouteLink resolves a standard directions link', async () => {
  const parsed = await service.parseRouteLink(
    'https://www.google.com/maps/dir/?api=1&origin=Atlanta,GA&destination=Miami,FL'
  );
  assert.equal(parsed.origin.raw, 'Atlanta,GA');
  assert.equal(parsed.destination.raw, 'Miami,FL');
});

test('parseRouteLink throws a clear error for an unreadable link', async () => {
  await assert.rejects(
    () => service.parseRouteLink('https://www.google.com/maps/@33.7,-84.3,12z'),
    /manually|origin and destination|place\/map view/i
  );
});

test('parseRouteLink throws the specific place/map-view error for a /maps/@ link', async () => {
  await assert.rejects(
    () => service.parseRouteLink('https://www.google.com/maps/@44.94,-93.07,13z'),
    (err) => {
      assert.equal(err.code, 'PLACE_OR_MAP_VIEW');
      assert.match(err.message, /place\/map view/i);
      return true;
    }
  );
});

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

// ── buildDriverGroupRouteMessage (pure) ──

test('buildDriverGroupRouteMessage escapes place text and href, keeps the mention', () => {
  const msg = service.buildDriverGroupRouteMessage(
    {
      original_url: 'https://maps.google.com/dir?a=1&b=2',
      origin_text: 'A & B',
      destination_text: 'C <x>',
      waypoints: [{ raw: 'W & Z' }],
    },
    { mentionHtml: '<a href="tg://user?id=9">Bob</a>' }
  );
  assert.match(msg, /🚚 <b>Route Assigned<\/b>/);
  assert.match(msg, /tg:\/\/user\?id=9/);
  assert.match(msg, /<b>Origin<\/b>\nA &amp; B/);
  assert.match(msg, /<b>Destination<\/b>\nC &lt;x&gt;/);
  // Waypoints are numbered, one per line.
  assert.match(msg, /<b>Stops \/ Waypoints<\/b>\n1\. W &amp; Z/);
  assert.match(msg, /href="https:\/\/maps\.google\.com\/dir\?a=1&amp;b=2"/);
  // No raw unescaped ampersand from the place text leaks into the body.
  assert.ok(!/A & B/.test(msg));
});

test('buildDriverGroupRouteMessage omits the link line for a manual (non-http) entry', () => {
  const msg = service.buildDriverGroupRouteMessage(
    { original_url: '(manual entry)', origin_text: 'A', destination_text: 'B', waypoints: [] },
    { mentionHtml: 'Bob' }
  );
  assert.ok(!/Open route in Google Maps/.test(msg));
  assert.match(msg, /<b>Origin<\/b>\nA/);
});

// ── sendDriverGroupRouteMessage ──

function loadServiceForSend({ assignment, profile = null, telegramExtra = {} } = {}) {
  const captured = { chatId: null, body: null, extra: null, recorded: null, event: null };
  const svc = loadServiceWith({
    '../database/db.js': {
      async getDriverProfileByGroupId() { return profile; },
    },
    '../database/routeControl.js': {
      async getRouteAssignment() { return assignment; },
      async recordDriverGroupMessageSent(id, opts) { captured.recorded = { id, opts }; return { id }; },
      async insertRouteMonitorEvent(e) { captured.event = e; return e; },
    },
  });
  const telegram = {
    async sendMessage(chatId, body, extra) {
      captured.chatId = chatId; captured.body = body; captured.extra = extra;
      return { message_id: 4242, ...telegramExtra };
    },
  };
  return { svc, telegram, captured };
}

test('sendDriverGroupRouteMessage sends to the driver group and records history', async () => {
  const { svc, telegram, captured } = loadServiceForSend({
    assignment: {
      id: 5, group_id: 7, telegram_group_id: -100200,
      original_url: 'https://maps.google.com/dir?a=1', origin_text: 'A', destination_text: 'B', waypoints: [],
    },
    profile: { telegram_user_id: 999, full_name: 'Bob Driver', group_name: 'G' },
  });
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram, sentBy: 'admin' });

  assert.equal(captured.chatId, -100200); // correct group — never a wrong chat id
  assert.equal(res.messageId, 4242);
  assert.equal(res.mentionConfidence, 'high');
  assert.equal(captured.extra.parse_mode, 'HTML');
  assert.match(captured.body, /tg:\/\/user\?id=999/);
  assert.equal(captured.recorded.id, 5);
  assert.equal(captured.recorded.opts.telegramMessageId, 4242);
  assert.equal(captured.recorded.opts.sentBy, 'admin');
  assert.equal(captured.event.eventType, 'driver_group_message_sent');
});

test('sendDriverGroupRouteMessage tags by @username when no id is known', async () => {
  const { svc, telegram, captured } = loadServiceForSend({
    assignment: { id: 5, group_id: 7, telegram_group_id: -100200, original_url: '(manual entry)', waypoints: [] },
    profile: { telegram_user_id: null, telegram_username: 'jd', full_name: 'Jane', group_name: 'G' },
  });
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram });
  assert.equal(res.mentionConfidence, 'medium');
  assert.match(captured.body, /@jd/);
});

test('sendDriverGroupRouteMessage uses the plain name when no Telegram account is known', async () => {
  const { svc, telegram, captured } = loadServiceForSend({
    assignment: { id: 5, group_id: 7, telegram_group_id: -100200, original_url: '(manual entry)', waypoints: [] },
    profile: { telegram_user_id: null, telegram_username: null, full_name: 'Jane Doe', group_name: 'G' },
  });
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram });
  assert.equal(res.mentionConfidence, 'low');
  assert.match(captured.body, /<b>Driver:<\/b> Jane Doe/);
});

test('sendDriverGroupRouteMessage escapes a custom message and still sends it', async () => {
  const { svc, telegram, captured } = loadServiceForSend({
    assignment: { id: 5, group_id: 7, telegram_group_id: -100200, original_url: '(manual entry)', waypoints: [] },
    profile: { telegram_user_id: 999, full_name: 'Bob', group_name: 'G' },
  });
  await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram, customMessage: '<b>hi</b> & bye' });
  assert.equal(captured.body, '&lt;b&gt;hi&lt;/b&gt; &amp; bye');
});

test('sendDriverGroupRouteMessage rejects clearly when the group has no Telegram chat id', async () => {
  const { svc, telegram, captured } = loadServiceForSend({
    assignment: { id: 5, group_id: 7, telegram_group_id: null, waypoints: [] },
  });
  await assert.rejects(
    () => svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram }),
    (err) => { assert.equal(err.code, 'NO_TELEGRAM_GROUP'); return true; }
  );
  assert.equal(captured.chatId, null); // nothing was sent anywhere
});

test('sendDriverGroupRouteMessage rejects a missing assignment with 404', async () => {
  const { svc, telegram } = loadServiceForSend({ assignment: null });
  await assert.rejects(
    () => svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram }),
    (err) => { assert.equal(err.code, 'NOT_FOUND'); assert.equal(err.status, 404); return true; }
  );
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

// ── Screenshot delivery + after-send activation ──────────────────────────────

function loadServiceForScreenshotSend({ assignment, screenshot = null, sendPhotoImpl = null } = {}) {
  const captured = {
    photos: [], texts: [], recorded: null, events: [], activated: null,
  };
  const svc = loadServiceWith({
    '../database/db.js': {
      async getDriverProfileByGroupId() { return { telegram_user_id: 999, full_name: 'Bob', group_name: 'G' }; },
    },
    '../database/routeControl.js': {
      async getRouteAssignment() { return assignment; },
      async getRouteScreenshot() { return screenshot; },
      async recordDriverGroupMessageSent(id, opts) { captured.recorded = { id, opts }; return { id }; },
      async insertRouteMonitorEvent(e) { captured.events.push(e); return e; },
      async activateTracking(id) { captured.activated = id; return { id }; },
    },
  });
  const telegram = {
    async sendPhoto(chatId, photo, extra) {
      if (sendPhotoImpl) return sendPhotoImpl(chatId, photo, extra);
      captured.photos.push({ chatId, photo, extra });
      return { message_id: 71 };
    },
    async sendMessage(chatId, body, extra) {
      captured.texts.push({ chatId, body, extra });
      return { message_id: 72 };
    },
  };
  return { svc, telegram, captured };
}

const SEND_ASSIGNMENT = {
  id: 5, group_id: 7, telegram_group_id: -100200,
  original_url: 'https://maps.google.com/dir?a=1', origin_text: 'A', destination_text: 'B', waypoints: [],
  tracking_start_mode: 'after_message_sent', tracking_status: 'pending',
};

test('sendDriverGroupRouteMessage sends the screenshot as a photo with the route caption', async () => {
  const { svc, telegram, captured } = loadServiceForScreenshotSend({
    assignment: SEND_ASSIGNMENT,
    screenshot: { file_data: Buffer.from('PNG'), mime_type: 'image/png' },
  });
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram, sentBy: 'admin' });
  assert.equal(captured.photos.length, 1);
  assert.equal(captured.texts.length, 0, 'short message fits the caption — no separate text');
  assert.equal(captured.photos[0].chatId, -100200);
  assert.match(captured.photos[0].extra.caption, /Route Assigned/);
  assert.equal(res.withScreenshot, true);
  assert.equal(res.sentVia, 'photo');
  assert.equal(res.messageId, 71);
});

test('sendDriverGroupRouteMessage splits photo + text when the message exceeds the caption limit', async () => {
  const longWaypoints = Array.from({ length: 30 }, (_, i) => ({ raw: `Stop number ${i} — Some Very Long Warehouse Name, 12345 Extremely Long Industrial Parkway Blvd, Suite ${i}, Springfield` }));
  const { svc, telegram, captured } = loadServiceForScreenshotSend({
    assignment: { ...SEND_ASSIGNMENT, waypoints: longWaypoints },
    screenshot: { file_data: Buffer.from('PNG'), mime_type: 'image/png' },
  });
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram });
  assert.equal(captured.photos.length, 1);
  assert.equal(captured.texts.length, 1, 'details follow as a separate message');
  assert.match(captured.photos[0].extra.caption, /details below/);
  assert.ok(captured.texts[0].body.length > 1024);
  assert.equal(res.sentVia, 'photo+text');
});

test('sendDriverGroupRouteMessage falls back to text when the photo send fails — and reports it truthfully', async () => {
  const { svc, telegram, captured } = loadServiceForScreenshotSend({
    assignment: SEND_ASSIGNMENT,
    screenshot: { file_data: Buffer.from('PNG'), mime_type: 'image/png' },
    sendPhotoImpl: async () => { const e = new Error('photo boom'); e.response = { error_code: 400, description: 'PHOTO_INVALID' }; throw e; },
  });
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram });
  assert.equal(captured.texts.length, 1, 'text route message still sent');
  assert.equal(res.sent, true);
  assert.equal(res.sentVia, 'text');
  assert.equal(res.withScreenshot, false);
  assert.equal(res.screenshotStored, true, 'screenshot remains stored for a retry');
  assert.match(res.screenshotError, /TELEGRAM_PHOTO_REJECTED/, 'failure is reported, not hidden');
  // The persisted send record carries the same truth for the Admin list.
  assert.equal(captured.recorded.opts.via, 'text');
  assert.match(captured.recorded.opts.screenshotError, /TELEGRAM_PHOTO_REJECTED/);
});

test('sendDriverGroupRouteMessage: photo 403 is surfaced as a bot permission failure', async () => {
  const { svc, telegram } = loadServiceForScreenshotSend({
    assignment: SEND_ASSIGNMENT,
    screenshot: { file_data: Buffer.from('PNG'), mime_type: 'image/png' },
    sendPhotoImpl: async () => { const e = new Error('kicked'); e.response = { error_code: 403 }; throw e; },
  });
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram });
  assert.match(res.screenshotError, /lacks permission/);
});

test('sendDriverGroupRouteMessage: 413/oversize and timeout photo errors are classified safely', () => {
  const svc = loadService();
  assert.match(
    svc.classifyTelegramPhotoError({ response: { error_code: 413 } }),
    /too large.*413/i
  );
  assert.equal(svc.classifyTelegramPhotoError(new Error('request timed out')), 'TELEGRAM_PHOTO_TIMEOUT');
});

test('sendDriverGroupRouteMessage: photo AND text failure → clear failure, nothing marked sent, no tracking', async () => {
  const captured = { recorded: null, activated: null };
  const svc = loadServiceWith({
    '../database/db.js': {
      async getDriverProfileByGroupId() { return { telegram_user_id: 999, full_name: 'Bob', group_name: 'G' }; },
    },
    '../database/routeControl.js': {
      async getRouteAssignment() { return SEND_ASSIGNMENT; },
      async getRouteScreenshot() { return { file_data: Buffer.from('PNG'), mime_type: 'image/png' }; },
      async recordDriverGroupMessageSent(id, opts) { captured.recorded = { id, opts }; return { id }; },
      async insertRouteMonitorEvent() { return null; },
      async activateTracking(id) { captured.activated = id; return { id }; },
    },
  });
  const boom = (code) => { const e = new Error('down'); e.response = { error_code: code }; throw e; };
  const telegram = {
    async sendPhoto() { boom(400); },
    async sendMessage() { boom(403); }, // permanent → safeSend rethrows immediately
  };
  await assert.rejects(() => svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram }));
  assert.equal(captured.recorded, null, 'driver_group_message_sent_at is NOT marked');
  assert.equal(captured.activated, null, 'after-message tracking is NOT activated');
});

test('sendDriverGroupRouteMessage: screenshot DB read failure still sends the text and reports the code', async () => {
  const captured = { texts: 0, recorded: null };
  const svc = loadServiceWith({
    '../database/db.js': {
      async getDriverProfileByGroupId() { return { telegram_user_id: 999, full_name: 'Bob', group_name: 'G' }; },
    },
    '../database/routeControl.js': {
      async getRouteAssignment() { return SEND_ASSIGNMENT; },
      async getRouteScreenshot() { throw new Error('bytea read failed'); },
      async recordDriverGroupMessageSent(id, opts) { captured.recorded = { id, opts }; return { id }; },
      async insertRouteMonitorEvent() { return null; },
      async activateTracking(id) { return { id }; },
    },
  });
  const telegram = { async sendMessage() { captured.texts += 1; return { message_id: 9 }; } };
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram });
  assert.equal(captured.texts, 1);
  assert.equal(res.sent, true);
  assert.equal(res.screenshotError, 'SCREENSHOT_DB_READ_FAILED');
});

test('sendDriverGroupRouteMessage activates after_message_sent tracking on success', async () => {
  const { svc, telegram, captured } = loadServiceForScreenshotSend({ assignment: SEND_ASSIGNMENT });
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram });
  assert.equal(captured.activated, 5);
  assert.equal(res.trackingActivated, true);
  assert.ok(captured.events.some((e) => e.eventType === 'tracking_started'));
});

test('sendDriverGroupRouteMessage does NOT activate tracking for other start modes', async () => {
  const { svc, telegram, captured } = loadServiceForScreenshotSend({
    assignment: { ...SEND_ASSIGNMENT, tracking_start_mode: 'scheduled_time' },
  });
  const res = await svc.sendDriverGroupRouteMessage({ assignmentId: 5, telegram });
  assert.equal(captured.activated, null);
  assert.equal(res.trackingActivated, false);
});

// ── updateDriverGroupRouteMessage: in-place Telegram edits (no resend) ────────

/**
 * Harness for the in-place editor. Mocks the driver mention + the DB read/write,
 * and a Telegram client exposing editMessageText/Caption/Media. `editImpl` lets a
 * test force a specific call to throw a Telegram-style error.
 */
function loadServiceForEdit({ assignment, screenshot = null, editImpl = {} } = {}) {
  const captured = { edits: [], recordedEdit: null, events: [] };
  const svc = loadServiceWith({
    '../services/driverMention.js': {
      async resolveDriverMentionForGroup() { return { mentionHtml: 'driver', source: 'name', confidence: 'low' }; },
      escapeHtml: (s) => String(s == null ? '' : s),
    },
    '../database/routeControl.js': {
      async getRouteAssignment() { return assignment; },
      async getRouteScreenshot() { return screenshot; },
      async recordDriverGroupMessageEdit(id, opts) { captured.recordedEdit = { id, opts }; return { id }; },
      async insertRouteMonitorEvent(e) { captured.events.push(e); return e; },
    },
  });
  const mk = (kind) => async (chatId, messageId, inlineId, a, b) => {
    captured.edits.push({ kind, chatId, messageId, a, b });
    if (editImpl[kind]) return editImpl[kind](chatId, messageId, inlineId, a, b);
    return { message_id: messageId };
  };
  const telegram = {
    editMessageText: mk('text'),
    editMessageCaption: mk('caption'),
    editMessageMedia: mk('media'),
  };
  return { svc, telegram, captured };
}

const EDIT_BASE = {
  id: 9, group_id: 7, telegram_group_id: -100900,
  original_url: 'https://maps.google.com/dir?a=1', origin_text: 'A', destination_text: 'B', waypoints: [],
  driver_group_message_sent_at: '2026-07-10T00:00:00Z',
};
const PNG = { file_data: Buffer.from('PNG-BYTES'), mime_type: 'image/png' };
const telegramErr = (code, description) => { const e = new Error(description || 'err'); e.response = { error_code: code, description }; return e; };

test('update: replace screenshot on a single photo message edits the media in place', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'photo', driver_group_messages: [{ message_id: 71, kind: 'photo' }] },
    screenshot: PNG,
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(res.code, 'UPDATED');
  assert.equal(res.screenshotUpdated, true);
  assert.equal(captured.edits.length, 1);
  assert.equal(captured.edits[0].kind, 'media');
  assert.equal(captured.edits[0].messageId, 71);
  assert.equal(captured.recordedEdit.opts.screenshotError, null, 'screenshot now shown → error cleared');
});

test('update: photo+text delivery edits BOTH the photo media and the text message', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: {
      ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'photo+text',
      driver_group_messages: [{ message_id: 71, kind: 'photo' }, { message_id: 72, kind: 'text' }],
    },
    screenshot: PNG,
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'updated route text' });
  assert.equal(res.code, 'UPDATED');
  assert.equal(res.screenshotUpdated, true);
  assert.equal(res.textUpdated, true);
  const media = captured.edits.find((e) => e.kind === 'media');
  const text = captured.edits.find((e) => e.kind === 'text');
  assert.equal(media.messageId, 71);
  assert.equal(text.messageId, 72);
  assert.match(text.a, /updated route text/);
});

test('update: text-only message edit changes the text in place', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: false, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    screenshot: null,
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'new text' });
  assert.equal(res.code, 'UPDATED');
  assert.equal(res.textUpdated, true);
  assert.equal(captured.edits.length, 1);
  assert.equal(captured.edits[0].kind, 'text');
  assert.equal(captured.edits[0].messageId, 72);
});

test('update: adding a screenshot to a text-only delivery CONVERTS it to a photo in place (Bot API 7.11+)', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    screenshot: PNG,
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'route body' });
  assert.equal(res.code, 'UPDATED');
  assert.equal(res.converted, true);
  assert.equal(res.conversion, 'text_to_photo');
  assert.equal(res.screenshotUpdated, true);
  assert.equal(res.textUpdated, true, 'the body becomes the photo caption');
  // editMessageMedia was called on the EXISTING text message id — no new message.
  assert.equal(captured.edits.length, 1);
  assert.equal(captured.edits[0].kind, 'media');
  assert.equal(captured.edits[0].messageId, 72);
  assert.equal(captured.edits[0].a.type, 'photo');
  assert.equal(captured.edits[0].a.caption, 'route body');
  // Metadata persisted so later replacements follow the photo branch.
  assert.equal(captured.recordedEdit.opts.via, 'photo');
  assert.deepEqual(captured.recordedEdit.opts.messages, [{ message_id: 72, kind: 'photo' }]);
  assert.equal(captured.recordedEdit.opts.screenshotError, null);
  assert.equal(captured.recordedEdit.opts.editError, null);
});

test('update: NO send/delete methods are used during a text→photo conversion', async () => {
  let forbidden = 0;
  const { svc, telegram } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    screenshot: PNG,
  });
  telegram.sendPhoto = async () => { forbidden += 1; return { message_id: 999 }; };
  telegram.sendMessage = async () => { forbidden += 1; return { message_id: 999 }; };
  telegram.deleteMessage = async () => { forbidden += 1; };
  await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(forbidden, 0, 'conversion must not send or delete any message');
});

test('update: legacy scalar-only text record converts on the same message id', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    // No driver_group_messages list at all — only the legacy scalar id + via.
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_message_id: 555, driver_group_messages: null },
    screenshot: PNG,
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(res.converted, true);
  assert.equal(captured.edits[0].kind, 'media');
  assert.equal(captured.edits[0].messageId, 555, 'edited the legacy-tracked id — no new message');
  assert.deepEqual(captured.recordedEdit.opts.messages, [{ message_id: 555, kind: 'photo' }]);
});

test('update: JSON-STRING message list is parsed and converted', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: JSON.stringify([{ message_id: 88, kind: 'text' }]) },
    screenshot: PNG,
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(res.converted, true);
  assert.equal(captured.edits[0].messageId, 88);
});

test('update: after conversion, a later replacement uses the photo branch on the same id', async () => {
  // The row now looks like a photo delivery (as persisted by the conversion).
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'photo', driver_group_messages: [{ message_id: 72, kind: 'photo' }] },
    screenshot: { file_data: Buffer.from('NEW-PNG'), mime_type: 'image/png' },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(res.code, 'UPDATED');
  assert.equal(res.converted, false, 'already a photo — not a conversion');
  assert.equal(res.conversion, 'photo_replace');
  assert.equal(captured.edits[0].kind, 'media');
  assert.equal(captured.edits[0].messageId, 72);
});

test('update: overlong route text declines the conversion (no truncation, no new message)', async () => {
  const longBody = 'x'.repeat(1100); // > 1024 caption limit after entity parsing
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    screenshot: PNG,
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: longBody });
  assert.equal(res.code, 'CAPTION_TOO_LONG_FOR_IN_PLACE_CONVERSION');
  assert.equal(res.screenshotUpdated, false);
  assert.equal(res.converted, false);
  assert.equal(captured.edits.length, 0, 'no Telegram mutation at all');
  assert.equal(captured.recordedEdit.opts.via, undefined, 'delivery type left unchanged');
  assert.equal(captured.recordedEdit.opts.messages, undefined, 'message list left unchanged');
  assert.equal(captured.recordedEdit.opts.screenshotError, 'CAPTION_TOO_LONG_FOR_IN_PLACE_CONVERSION');
});

test('update: a rejected conversion leaves the delivery as TEXT and reports the classified error', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    screenshot: PNG,
    editImpl: { media: () => { throw telegramErr(400, 'Bad Request: message to edit not found'); } },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(res.converted, false);
  assert.equal(res.updated, false);
  assert.equal(res.code, 'MESSAGE_NOT_FOUND');
  assert.equal(captured.recordedEdit.opts.via, undefined, 'metadata NOT converted on failure');
  assert.equal(captured.recordedEdit.opts.messages, undefined);
  assert.equal(captured.recordedEdit.opts.screenshotError, 'MESSAGE_NOT_FOUND');
});

// ── Transient network resilience for the text→photo conversion (prod bug 22) ──

const noRetryWait = { sleep: async () => {}, random: () => 0 };
const socketHangUp = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

test('update: socket hang up on the conversion is retried and succeeds — metadata persisted, no new message', async () => {
  let calls = 0;
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 1410, kind: 'text' }] },
    screenshot: PNG,
    editImpl: { media: () => { calls += 1; if (calls === 1) throw socketHangUp(); return { message_id: 1410 }; } },
  });
  telegram.sendPhoto = () => { throw new Error('must not send'); };
  telegram.sendMessage = () => { throw new Error('must not send'); };
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, retry: noRetryWait });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'updated');
  assert.equal(res.converted, true);
  assert.equal(res.attempts, 2);
  assert.equal(calls, 2, 'edited the SAME message id twice — retried in place, never a new message');
  assert.equal(captured.recordedEdit.opts.via, 'photo', 'metadata persisted only after confirmed success');
  assert.deepEqual(captured.recordedEdit.opts.messages, [{ message_id: 1410, kind: 'photo' }]);
});

test('update: three socket hang ups → UNCONFIRMED (ambiguous), metadata unchanged, no new message', async () => {
  let calls = 0;
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 1410, kind: 'text' }] },
    screenshot: PNG,
    editImpl: { media: () => { calls += 1; throw socketHangUp(); } },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, retry: noRetryWait });
  assert.equal(calls, 3);
  assert.equal(res.ok, false);
  assert.equal(res.status, 'unconfirmed');
  assert.equal(res.ambiguousOutcome, true);
  assert.equal(res.code, 'TELEGRAM_CONNECTION_RESET');
  assert.equal(res.category, 'transport');
  assert.equal(res.transportCode, 'ECONNRESET');
  assert.equal(res.attempts, 3);
  assert.equal(res.operation, 'edit_media_text_to_photo');
  assert.match(res.detail, /could not be confirmed after 3 attempts/i);
  assert.ok(res.correlationId && res.correlationId.startsWith('rc-edit-'));
  // Delivery metadata must NOT be marked converted on an unconfirmed outcome.
  assert.equal(captured.recordedEdit.opts.via, undefined);
  assert.equal(captured.recordedEdit.opts.messages, undefined);
});

test('update: lost response then "message is not modified" on retry → confirmed success', async () => {
  let calls = 0;
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 1410, kind: 'text' }] },
    screenshot: PNG,
    editImpl: {
      media: () => {
        calls += 1;
        if (calls === 1) throw socketHangUp();
        throw telegramErr(400, 'Bad Request: message is not modified');
      },
    },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, retry: noRetryWait });
  assert.equal(res.ok, true);
  assert.equal(res.converted, true, 'the earlier request had applied — treated as success');
  assert.equal(res.attempts, 2);
  assert.equal(captured.recordedEdit.opts.via, 'photo');
});

test('update: transport failure exposes safe structured fields with no secrets', async () => {
  const { svc, telegram } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 1410, kind: 'text' }] },
    screenshot: PNG,
    editImpl: { media: () => { throw Object.assign(new Error('write EPROTO https://api.telegram.org/bot123:SECRET/x'), { code: 'ECONNRESET' }); } },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, retry: noRetryWait });
  const blob = JSON.stringify(res);
  assert.doesNotMatch(blob, /SECRET/);
  assert.doesNotMatch(blob, /bot123:/);
  assert.doesNotMatch(blob, /api\.telegram\.org/);
});

test('update: removing a screenshot from a photo message cannot strip the image in place', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: false, driver_group_message_via: 'photo', driver_group_messages: [{ message_id: 71, kind: 'photo' }] },
    screenshot: null,
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.ok(res.limitations.includes('PHOTO_IMAGE_CANNOT_BE_REMOVED_IN_PLACE'));
  assert.equal(res.screenshotRemovedInTelegram, false);
  assert.equal(captured.recordedEdit.opts.screenshotError, 'SCREENSHOT_STILL_SHOWN_IN_TELEGRAM');
  // It edits the caption (keeps text current) but never posts/deletes anything.
  assert.equal(captured.edits.some((e) => e.kind === 'caption'), true);
});

test('update: never sent → NO_SENT_MESSAGE, nothing edited or sent', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, driver_group_message_sent_at: null, driver_group_messages: null, driver_group_message_id: null },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(res.code, 'NO_SENT_MESSAGE');
  assert.equal(captured.edits.length, 0);
});

test('update: sent earlier but no editable message id on file → NO_SENT_MESSAGE with guidance', async () => {
  const { svc, telegram } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, driver_group_messages: null, driver_group_message_id: null },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(res.code, 'NO_SENT_MESSAGE');
  assert.match(res.detail, /no editable Telegram message id/i);
});

test('update: reconstructs legacy scalar id (via=photo) when no message list exists', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'photo', driver_group_message_id: 555, driver_group_messages: null },
    screenshot: PNG,
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(res.screenshotUpdated, true);
  assert.equal(captured.edits[0].kind, 'media');
  assert.equal(captured.edits[0].messageId, 555, 'edited the legacy-tracked message id — restart-safe');
});

test('update: driver_group_messages stored as a JSON STRING is parsed (restart-safe)', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: false, driver_group_message_via: 'text', driver_group_messages: JSON.stringify([{ message_id: 88, kind: 'text' }]) },
    screenshot: null,
  });
  await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'x' });
  assert.equal(captured.edits[0].messageId, 88);
});

test('update: Telegram edit failure is reported truthfully, not as success', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'photo', driver_group_messages: [{ message_id: 71, kind: 'photo' }] },
    screenshot: PNG,
    editImpl: { media: () => { throw telegramErr(400, 'Bad Request: MEDIA_INVALID'); } },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(res.updated, false);
  assert.equal(res.screenshotUpdated, false);
  assert.match(res.code, /TELEGRAM_EDIT_REJECTED/);
  assert.ok(res.editError, 'edit error captured');
  assert.ok(captured.recordedEdit.opts.editError, 'edit failure persisted for the admin list');
});

test('update: message no longer found is classified', async () => {
  const { svc, telegram } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: false, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    editImpl: { text: () => { throw telegramErr(400, 'Bad Request: message to edit not found'); } },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'x' });
  assert.equal(res.code, 'MESSAGE_NOT_FOUND');
});

test('update: bot permission failure (403) is classified', async () => {
  const { svc, telegram } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: false, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    editImpl: { text: () => { throw telegramErr(403, 'Forbidden: not enough rights'); } },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'x' });
  assert.equal(res.code, 'BOT_PERMISSION');
});

test('update: "message can\'t be edited" is classified as not editable', async () => {
  const { svc, telegram } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: false, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    editImpl: { text: () => { throw telegramErr(400, "Bad Request: message can't be edited"); } },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'x' });
  assert.equal(res.code, 'MESSAGE_NOT_EDITABLE');
});

test('update: "message is not modified" counts as success (no false failure)', async () => {
  const { svc, telegram } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: false, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    editImpl: { text: () => { throw telegramErr(400, 'Bad Request: message is not modified'); } },
  });
  const res = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'x' });
  assert.equal(res.textUpdated, true);
  assert.equal(res.code, 'UPDATED');
});

test('update: repeated replacements keep editing the SAME message id', async () => {
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: true, driver_group_message_via: 'photo', driver_group_messages: [{ message_id: 71, kind: 'photo' }] },
    screenshot: PNG,
  });
  await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram });
  assert.equal(captured.edits.length, 2);
  assert.ok(captured.edits.every((e) => e.messageId === 71 && e.kind === 'media'));
});

test('update: near-simultaneous requests do not double-edit (in-flight guard)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { svc, telegram, captured } = loadServiceForEdit({
    assignment: { ...EDIT_BASE, has_screenshot: false, driver_group_message_via: 'text', driver_group_messages: [{ message_id: 72, kind: 'text' }] },
    editImpl: { text: async () => { await gate; return { message_id: 72 }; } },
  });
  const p1 = svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'x' });
  // Let p1 progress past the in-flight guard and park inside editMessageText.
  await new Promise((r) => setImmediate(r));
  const r2 = await svc.updateDriverGroupRouteMessage({ assignmentId: 9, telegram, customMessage: 'x' });
  assert.equal(r2.code, 'EDIT_IN_PROGRESS', 'second concurrent request is rejected, not double-edited');
  release();
  const r1 = await p1;
  assert.equal(r1.code, 'UPDATED');
  assert.equal(captured.edits.length, 1, 'only one edit actually happened');
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

// ── Clean English route message ──────────────────────────────────────────────

test('cleanAddressText strips Cyrillic and English country suffixes', () => {
  assert.equal(service.cleanAddressText('400 Oldfield Blvd, Pittston, PA 18640, США'), '400 Oldfield Blvd, Pittston, PA 18640');
  assert.equal(service.cleanAddressText('Monteagle, TN 37356, Соединенные Штаты Америки'), 'Monteagle, TN 37356');
  assert.equal(service.cleanAddressText('Hanahan, SC 29410, Соединённые Штаты'), 'Hanahan, SC 29410');
  assert.equal(service.cleanAddressText('Dillon, SC 29536, USA'), 'Dillon, SC 29536');
  assert.equal(service.cleanAddressText('Dallas, TX, United States of America'), 'Dallas, TX');
  assert.equal(service.cleanAddressText('  Chicago,   IL  '), 'Chicago, IL');
});

test('buildDriverGroupRouteMessage removes США from every section and numbers the stops', () => {
  const msg = service.buildDriverGroupRouteMessage({
    original_url: 'https://maps.app.goo.gl/x',
    origin_text: '32.956089, -80.005777',
    destination_text: '400 Oldfield Blvd, Pittston, PA 18640, США',
    waypoints: [
      { raw: 'Expeditors International — 1017 N Pointe Industrial Blvd, Hanahan, SC 29410, США' },
      { raw: 'Trade Zone Blvd, Summerville, SC 29486, Соединенные Штаты' },
      { raw: 'C.H. Robinson — 1911 SC-34, Dillon, SC 29536, USA' },
    ],
    tracking_start_mode: 'immediate', tracking_status: 'active',
  }, { mentionHtml: '@driver' });
  assert.ok(!/США|Соединенн|Соединённ/.test(msg), 'no Cyrillic country labels remain');
  assert.match(msg, /1\. Expeditors International — 1017 N Pointe Industrial Blvd, Hanahan, SC 29410/);
  assert.match(msg, /2\. Trade Zone Blvd, Summerville, SC 29486/);
  assert.match(msg, /3\. C\.H\. Robinson — 1911 SC-34, Dillon, SC 29536/);
  assert.match(msg, /<b>Tracking<\/b>/);
  assert.match(msg, /Route Control is now monitoring/);
});

test('buildDriverGroupRouteMessage stays under the Telegram text limit with huge waypoint lists', () => {
  const waypoints = Array.from({ length: 120 }, (_, i) => ({
    raw: `Stop ${i + 1} — Warehouse With A Really Long Name, 12345 Industrial Parkway Boulevard, Suite ${i + 1}, Some City, ST 00000`,
  }));
  const msg = service.buildDriverGroupRouteMessage({
    original_url: 'https://maps.google.com/dir?x=1',
    origin_text: 'A', destination_text: 'B', waypoints,
  }, { mentionHtml: '@driver' });
  assert.ok(msg.length <= 4096, `message must fit Telegram text limit (got ${msg.length})`);
  assert.match(msg, /… and \d+ more stops/);
});

test('buildDriverGroupRouteMessage describes scheduled and start-location tracking', () => {
  const scheduled = service.buildDriverGroupRouteMessage({
    original_url: '(manual entry)', origin_text: 'A', destination_text: 'B', waypoints: [],
    tracking_start_mode: 'scheduled_time', tracking_start_at: '2026-08-01T15:00:00Z', tracking_status: 'pending',
  }, { mentionHtml: '@d' });
  assert.match(scheduled, /will start monitoring at .*CST/);

  const byLocation = service.buildDriverGroupRouteMessage({
    original_url: '(manual entry)', origin_text: 'A', destination_text: 'B', waypoints: [],
    tracking_start_mode: 'start_location', tracking_start_location_text: '35.2331, -85.7095',
    tracking_start_radius_miles: 3, tracking_status: 'pending',
  }, { mentionHtml: '@d' });
  assert.match(byLocation, /when the truck reaches 35\.2331, -85\.7095 \(within 3 mi\)/);
});

// ── Destination auto-completion ───────────────────────────────────────────────

const { evaluateDestinationCompletion } = service;

// Distances along a meridian (dLng = 0) are exact for haversine: R * dLatRad.
// This lets us place a GPS point at a KNOWN mileage from the destination.
const EARTH_R_M = 6_371_000;
const M_PER_MILE = 1609.34;
const DEST = { status: 'active', destination_lat: 40, destination_lng: -100 };

/** A fresh GPS ping exactly `miles` due south of the destination. */
function pointMilesFromDest(miles, extra = {}) {
  const dLatDeg = ((miles * M_PER_MILE) / EARTH_R_M) * (180 / Math.PI);
  return {
    latitude: 40 - dLatDeg, longitude: -100, speedMilesPerHour: 55, pingAgeMinutes: 1, ...extra,
  };
}

const COMPLETION_SETTINGS = { staleGpsMinutes: 15, completionRadiusMiles: 50 };

function completion(location, assignmentOverrides = {}, settings = COMPLETION_SETTINGS) {
  return evaluateDestinationCompletion({
    assignment: { ...DEST, ...assignmentOverrides },
    location,
    staleGpsMinutes: settings.staleGpsMinutes,
    completionRadiusMiles: settings.completionRadiusMiles,
  });
}

test('evaluateDestinationCompletion: 5 miles from destination → complete', () => {
  const v = completion(pointMilesFromDest(5));
  assert.equal(v.shouldComplete, true);
  assert.ok(Math.abs(v.distanceMiles - 5) < 0.01);
});

test('evaluateDestinationCompletion: 20 miles → complete', () => {
  assert.equal(completion(pointMilesFromDest(20)).shouldComplete, true);
});

test('evaluateDestinationCompletion: 49.9 miles → complete (just inside)', () => {
  assert.equal(completion(pointMilesFromDest(49.9)).shouldComplete, true);
});

test('evaluateDestinationCompletion: exactly 50 miles → complete (inclusive boundary)', () => {
  const v = completion(pointMilesFromDest(50));
  assert.equal(v.shouldComplete, true);
  assert.ok(Math.abs(v.distanceMiles - 50) < 0.001);
});

test('evaluateDestinationCompletion: 50.1 miles → NOT complete (just outside)', () => {
  const v = completion(pointMilesFromDest(50.1));
  assert.equal(v.shouldComplete, false);
  assert.equal(v.code, 'OUTSIDE_COMPLETION_RADIUS');
});

test('evaluateDestinationCompletion: 60 miles → NOT complete, monitoring continues', () => {
  assert.equal(completion(pointMilesFromDest(60)).shouldComplete, false);
});

test('evaluateDestinationCompletion: the authoritative DEFAULT radius is 50 miles', () => {
  // No completionRadiusMiles passed at all → the constants default applies.
  const inside = completion(pointMilesFromDest(45), {}, { staleGpsMinutes: 15, completionRadiusMiles: undefined });
  assert.equal(inside.shouldComplete, true, '45 mi completes under the 50 mi default');
  const outside = completion(pointMilesFromDest(51), {}, { staleGpsMinutes: 15, completionRadiusMiles: undefined });
  assert.equal(outside.shouldComplete, false, '51 mi does not complete under the 50 mi default');
});

test('evaluateDestinationCompletion: numeric coordinate STRINGS are normalized', () => {
  const v = completion(
    { latitude: String(pointMilesFromDest(5).latitude), longitude: '-100', speedMilesPerHour: 55, pingAgeMinutes: 1 },
    { destination_lat: '40', destination_lng: '-100' }
  );
  assert.equal(v.shouldComplete, true);
});

test('evaluateDestinationCompletion: stale GPS never completes, even inside the radius', () => {
  const v = completion(pointMilesFromDest(5, { pingAgeMinutes: 40 }));
  assert.equal(v.shouldComplete, false);
  assert.match(v.reason, /old/);
});

test('evaluateDestinationCompletion: missing GPS → not complete', () => {
  assert.equal(completion(null).shouldComplete, false);
  assert.equal(completion({ latitude: null, longitude: null }).shouldComplete, false);
});

test('evaluateDestinationCompletion: missing/invalid destination → not complete, classified as missing coords', () => {
  for (const overrides of [
    { destination_lat: null }, // Number(null)===0 must NOT count as a coordinate
    { destination_lng: undefined },
    { destination_lat: NaN, destination_lng: NaN },
  ]) {
    const v = completion(pointMilesFromDest(2), overrides);
    assert.equal(v.shouldComplete, false);
    assert.equal(v.code, 'DESTINATION_COORDINATES_MISSING');
  }
});

test('evaluateDestinationCompletion: cancelled or already-completed routes never complete', () => {
  for (const status of ['cancelled', 'completed']) {
    const v = completion(pointMilesFromDest(1), { status });
    assert.equal(v.shouldComplete, false);
    assert.match(v.reason, new RegExp(status));
  }
});

test('evaluateDestinationCompletion: works WITHOUT an encoded polyline (destination coords are enough)', () => {
  const v = completion(pointMilesFromDest(3), { encoded_polyline: null });
  assert.equal(v.shouldComplete, true);
});

/** runRouteMonitorCheck harness with completion-aware routeControl + resolver stubs. */
function loadServiceForCompletion({
  assignments, location, completeReturns = 'active', gmapsEnabled = true,
  gmapsThrows = false, resolverThrows = null, resolverCapture = null, extraRcMock = {},
}) {
  const captured = {
    completed: [], events: [], monitorStates: [], telegramSends: [], diagnostics: [], activated: [],
  };
  const svc = loadServiceWith({
    '../database/gmapsSettings.js': {
      async getGmapsConfig() {
        if (gmapsThrows) throw new Error('settings table unavailable');
        return {
          enabled: gmapsEnabled, deviationThresholdMeters: 250, offRouteGraceChecks: 3,
          warningCooldownMinutes: 30, staleGpsMinutes: 15, parkedSpeedMph: 5,
          checkIntervalSeconds: 300, routeCompletionRadiusMiles: 50,
        };
      },
    },
    '../services/liveLocationResolver.js': {
      async resolveLiveLocationForGroupTitle(groupTitle, opts) {
        if (resolverCapture) resolverCapture.push({ groupTitle, opts });
        if (resolverThrows) { const e = new Error(resolverThrows); e.code = resolverThrows; throw e; }
        return { location, source: 'Samsara' };
      },
    },
    '../database/routeControl.js': {
      async listActiveAssignmentsForMonitor() { return assignments; },
      async completeRouteAssignment(id, data) {
        captured.completed.push({ id, data });
        // 'active' → we won the race and get the row back; 'raced' → another tick
        // already completed it (WHERE status='active' matched nothing → null).
        return completeReturns === 'active' ? { id, status: 'completed', ...data } : null;
      },
      async insertRouteMonitorEvent(e) { captured.events.push(e); return e; },
      async updateRouteAssignmentMonitorState(id, s) { captured.monitorStates.push({ id, s }); return null; },
      async updateCompletionDiagnostics(id, d) { captured.diagnostics.push({ id, ...d }); return { id }; },
      async setTrackingHoldReason() { return null; },
      async activateTracking(id) { captured.activated.push(id); return { id }; },
      async setRouteAssignmentDestinationCoords() { return null; },
      async recordDestinationRepairAttempt() { return null; },
      ...extraRcMock,
    },
  });
  const telegram = {
    async sendMessage(chatId, text, extra) { captured.telegramSends.push({ chatId, text, extra }); return { message_id: 1 }; },
  };
  return { svc, telegram, captured };
}

const NEAR_DEST_OFF_ROUTE = pointMilesFromDest(8); // 8 mi from dest, far from the POLYLINE below

test('runRouteMonitorCheck auto-completes a route inside the radius, silently, skipping off-route', async () => {
  // Driver is 8 mi from the destination but off the encoded route. Completion
  // must fire FIRST: status completed, one audit event, ZERO telegram messages.
  const { svc, telegram, captured } = loadServiceForCompletion({
    assignments: [{
      id: 21, status: 'active', tracking_status: 'active',
      encoded_polyline: POLYLINE, // driver is nowhere near this
      destination_lat: 40, destination_lng: -100,
      consecutive_off_route: 2, group_name: 'G', telegram_group_id: -100500,
    }],
    location: NEAR_DEST_OFF_ROUTE,
  });
  const res = await svc.runRouteMonitorCheck(telegram, { now: NOW });
  assert.equal(res.completed, 1);
  assert.equal(res.notified, 0);
  assert.equal(captured.completed.length, 1);
  assert.equal(captured.completed[0].id, 21);
  assert.ok(Math.abs(captured.completed[0].data.distanceMeters - 8 * M_PER_MILE) < 2);
  // Exactly one completion audit event, no off-route/warning event.
  assert.equal(captured.events.length, 1);
  assert.equal(captured.events[0].eventType, 'destination_reached');
  assert.equal(captured.events[0].result, 'completed');
  assert.match(captured.events[0].detail, /Auto-completed: fresh GPS was 8\.0 miles/);
  // No Telegram message of any kind.
  assert.equal(captured.telegramSends.length, 0);
  // Off-route monitor state was NOT written (we skipped that branch).
  assert.equal(captured.monitorStates.length, 0);
});

test('runRouteMonitorCheck completes a route that has NO polyline (destination-only)', async () => {
  const { svc, telegram, captured } = loadServiceForCompletion({
    assignments: [{
      id: 22, status: 'active', tracking_status: 'active',
      encoded_polyline: null, destination_lat: 40, destination_lng: -100,
      group_name: 'G', telegram_group_id: -100501,
    }],
    location: pointMilesFromDest(4),
  });
  const res = await svc.runRouteMonitorCheck(telegram, { now: NOW });
  assert.equal(res.completed, 1);
  assert.equal(captured.events[0].eventType, 'destination_reached');
  assert.equal(captured.telegramSends.length, 0);
});

test('runRouteMonitorCheck does NOT double-complete on overlapping ticks', async () => {
  // completeRouteAssignment returns null → another tick already completed it.
  const { svc, telegram, captured } = loadServiceForCompletion({
    assignments: [{
      id: 23, status: 'active', tracking_status: 'active',
      encoded_polyline: null, destination_lat: 40, destination_lng: -100,
      group_name: 'G', telegram_group_id: -100502,
    }],
    location: pointMilesFromDest(2),
    completeReturns: 'raced',
  });
  const res = await svc.runRouteMonitorCheck(telegram, { now: NOW });
  assert.equal(captured.completed.length, 1, 'attempted once');
  assert.equal(res.completed, 0, 'not counted — lost the race');
  assert.equal(captured.events.length, 0, 'no duplicate audit event');
  assert.equal(captured.telegramSends.length, 0);
});

test('runRouteMonitorCheck keeps normal off-route warning when the driver is OUTSIDE the radius', async () => {
  // Far from destination AND off the route → completion does not fire; the
  // existing off-route warning path runs as before.
  const { svc, telegram, captured } = loadServiceForCompletion({
    assignments: [{
      id: 24, status: 'active', tracking_status: 'active',
      encoded_polyline: POLYLINE,
      destination_lat: 40, destination_lng: -100, // ~800+ mi from the polyline/off point
      consecutive_off_route: 2, last_notification_at: null,
      group_name: 'G', telegram_group_id: -100503,
    }],
    location: offRoute, // off the polyline, and nowhere near (40,-100)
  });
  const res = await svc.runRouteMonitorCheck(telegram, { now: NOW });
  assert.equal(res.completed, 0);
  assert.equal(res.checked, 1);
  assert.equal(res.notified, 1, 'off-route warning still sent');
  assert.equal(captured.telegramSends.length, 1);
  assert.match(captured.telegramSends[0].text, /off the assigned route/i);
  assert.ok(!captured.events.some((e) => e.eventType === 'destination_reached'));
});

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
