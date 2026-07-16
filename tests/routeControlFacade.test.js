/**
 * Contract tests for the Route Control compatibility façade
 * (services/routeControlService.js → services/routeControl/*).
 *
 * These guard the refactor itself: the public API other files import must stay
 * exactly as it was, requiring the package must have no side effects, and the
 * package must never depend on the façade (which would be a require cycle).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { loadService, purgeService } = require('./helpers/routeControlHarness');

const PACKAGE_DIR = path.resolve(__dirname, '../services/routeControl');

/**
 * The exported names as of the pre-refactor single-file service. Callers
 * (bot/routeControlHandlers.js, server/routes/routeControlRoutes.js, index.js)
 * rely on these — this list must only ever grow, never lose an entry.
 */
const PUBLIC_API = [
  'assignRoute',
  'buildDeliveryMessageList',
  'buildDriverGroupRouteMessage',
  'buildOffRouteMessage',
  'cancelActiveRoutesForGroup',
  'classifyTelegramEditError',
  'classifyTelegramPhotoError',
  'cleanAddressText',
  'computeGeometryForAssignment',
  'describeTrackingStartCondition',
  'destinationCoordFromPolyline',
  'estimatedCaptionLength',
  'evaluateAssignment',
  'evaluateDestinationCompletion',
  'evaluateTrackingStart',
  'monitorSettingsFromConfig',
  'normalizeTrackingOptions',
  'parseDeliveryMessages',
  'parseRouteLink',
  'runCompletionCheckNow',
  'runRouteMonitorCheck',
  'sendDriverGroupRouteMessage',
  'startRouteControlService',
  'startTrackingNow',
  'stopRouteControlService',
  'tick',
  'updateDriverGroupRouteMessage',
];

test('the façade exports exactly the documented public API, all callable', () => {
  const service = loadService();
  assert.deepEqual(Object.keys(service).sort(), PUBLIC_API,
    'the public API changed — update every caller, or restore the missing export');
  for (const name of PUBLIC_API) {
    assert.equal(typeof service[name], 'function', `${name} must be a function`);
  }
});

test('the façade and the package index expose the same object', () => {
  const service = loadService();
  assert.equal(service, require(PACKAGE_DIR),
    'the façade must re-export the package verbatim, adding no behavior');
});

test('no module inside the package requires the façade (no require cycle)', () => {
  const offenders = [];
  for (const file of fs.readdirSync(PACKAGE_DIR)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(PACKAGE_DIR, file), 'utf8');
    if (/require\(\s*['"][^'"]*routeControlService['"]\s*\)/.test(src)) offenders.push(file);
    // A module requiring its own package index would also close a cycle.
    if (file !== 'index.js' && /require\(\s*['"]\.\/index['"]\s*\)/.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    'Route Control modules must depend on focused modules, never back on the façade/index');
});

test('requiring the package has no side effects (no timers, no I/O at import)', () => {
  // A stray setInterval at module scope would keep the process alive and make
  // the monitor start itself on import. Loading must be inert until
  // startRouteControlService is called.
  purgeService();
  const before = process._getActiveHandles().length;
  loadService();
  assert.equal(process._getActiveHandles().length, before,
    'requiring Route Control must not create timers or handles');
});
