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
