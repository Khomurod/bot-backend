/**
 * Shared harness for the Route Control service tests.
 *
 * Loads services/routeControlService (the compatibility façade over the
 * services/routeControl/* package) with its DB / Google / telegram / resolver
 * deps stubbed via require.cache, so the PURE decision logic and the
 * orchestration can be tested without env, network, or a database.
 */
const path = require('node:path');
const fs = require('node:fs');

const SERVICE_PATH = path.resolve(__dirname, '../../services/routeControlService.js');
const PACKAGE_DIR = path.resolve(__dirname, '../../services/routeControl');
// Stub keys stay written as they always were — relative to the tests/ directory
// (e.g. '../database/db.js') — so every call site reads the same as before.
const TESTS_DIR = path.resolve(__dirname, '..');

/**
 * routeControlService is a thin façade over the services/routeControl/* package,
 * so purging only the façade would leave the package modules cached against a
 * PREVIOUS load's stubs — every load must drop the whole package too, otherwise
 * `loadServiceWith` overrides would be silently ignored.
 */
function purgeService() {
  delete require.cache[SERVICE_PATH];
  for (const file of fs.readdirSync(PACKAGE_DIR)) {
    if (file.endsWith('.js')) delete require.cache[path.join(PACKAGE_DIR, file)];
  }
}

/**
 * Load the service with custom stubs for the modules a test cares about (merged
 * over sensible defaults). Returns a fresh service instance bound to the stubs.
 */
function loadServiceWith(overrides = {}) {
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
  purgeService();
  for (const [rel, exports] of Object.entries(stubs)) {
    require.cache[path.resolve(TESTS_DIR, rel)] = { exports };
  }
  return require(SERVICE_PATH);
}

/** The default stub set — enough for the pure decision logic and link parsing. */
function loadService() {
  return loadServiceWith({
    '../database/db.js': {},
    '../database/routeControl.js': {},
  });
}

// ── Shared fixtures ──────────────────────────────────────────────────────────

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

module.exports = {
  purgeService,
  loadServiceWith,
  loadService,
  POLYLINE,
  SETTINGS,
  NOW,
  assignment,
  onRoute,
  offRoute,
};
