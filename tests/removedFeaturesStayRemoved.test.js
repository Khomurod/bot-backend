'use strict';

/**
 * The removed features do NO work, and the surviving ones still boot.
 *
 * The Trailer Department, Trailer Tracking and QBQ/SOS were removed, and
 * FleetView before them. "Removed" has to mean more than "the admin page is
 * gone": no route, no background job, no Telegram handler, no module left
 * behind for something to require by accident.
 *
 * WHY A STATIC TEST AND NOT A BUILD. `server/api.js` mounted the trailer
 * routers inside a `try/catch` so a Beta feature could not take down the API —
 * which means a half-finished deletion boots perfectly and answers 404, and a
 * green build says nothing. These assertions are what notice.
 *
 * The boot-graph test at the end is the other half: it loads the whole module
 * graph `index.js` pulls in, with no application env, so a dangling `require`
 * left anywhere in it fails here rather than at 3am on a deploy.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/** Every hand-written .js/.jsx path in the tree, for the sweeps below. */
function sourceFiles() {
  const out = [];
  const skip = new Set(['node_modules', '.git', 'build', 'dist', 'coverage']);
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (/\.(js|jsx|mjs|cjs)$/.test(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
  }(ROOT));
  return out;
}

test('no directory or module of a removed feature remains', () => {
  for (const gone of [
    'fleet', 'server/fleet',                       // FleetView
    'server/qbq', 'services/qbq', 'services/sosAssessment',
    'admin/src/pages/sos', 'admin/src/pages/sosPublic',
    'admin/src/pages/trailer', 'admin/src/pages/trailerTracking',
    'lib/trailers', 'services/trailerMonitor', 'services/trailerAgreements',
    'services/trailerStorage', 'database/trailerTracking',
    'server/routes/trailerDepartment',
    'database/sosAssessment.js', 'database/qbqPresentation.js',
    'server/routes/sosRoutes.js', 'server/routes/qbqRoutes.js',
    'server/routes/trailerRoutes.js', 'config/trailerDepartmentFlag.js',
  ]) {
    assert.equal(exists(gone), false, `${gone} must stay removed`);
  }
});

test('nothing in the tree requires a removed module', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    const refs = [
      ...src.matchAll(/require\(['"]([^'"]*(?:trailer|sosAssessment|qbq)[^'"]*)['"]\)/gi),
      ...src.matchAll(/from\s+['"]([^'"]*(?:trailer|sosAssessment|\/sos|qbq)[^'"]*)['"]/gi),
    ];
    for (const ref of refs) offenders.push(`${path.relative(ROOT, file)} → ${ref[1]}`);
  }
  assert.deepEqual(offenders, [], 'a removed module is still being imported');
});

test('no background job of a removed feature is started or stopped', () => {
  const index = read('index.js');
  for (const gone of [
    'startTrailerNotificationService', 'stopTrailerNotificationService',
    'trailerDepartmentEnabled', 'mountFleet',
  ]) {
    assert.ok(!index.includes(gone), `index.js must not reference ${gone}`);
  }
  // …and the surviving jobs are all still both started and stopped.
  const started = [...index.matchAll(/^\s*(start[A-Z]\w+)\(/gm)].map((m) => m[1]);
  assert.ok(started.length >= 15, `expected the surviving jobs to still start, saw ${started.length}`);
  for (const start of started) {
    if (start === 'startServer' || start === 'startLeadsBot') continue;
    const stop = start.replace(/^start/, 'stop');
    assert.ok(index.includes(stop), `${start} is started but ${stop} is never called on shutdown`);
  }
});

test('an ordinary driver-group message reaches no removed feature', () => {
  const pipeline = read('bot/handlers/groupCaptureHandlers.js');
  for (const gone of ['trailer', 'Trailer', 'sos', 'qbq']) {
    assert.ok(!pipeline.includes(gone), `the group pipeline must not mention ${gone}`);
  }
  // The surviving fan-out is intact: this is what the removal must not have cost.
  for (const kept of [
    'handleDriverGroupStatus',      // home time state machine
    'handleFuelStopMessage',        // fuel monitor
    'processHomeTimeMessage',       // conversational home-time flow
    'applyAutoReaction',            // auto-reactions
    'recentMessageBuffer',          // rolling chat buffer
    'upsertGroupPinnedMessageSnapshot', // pinned context
    'recordGroupMessageSeen',       // bot-visibility diagnostic
  ]) {
    assert.ok(pipeline.includes(kept), `the group pipeline must still call ${kept}`);
  }
});

test('the API mounts no removed router, and still mounts the surviving ones', () => {
  const api = read('server/api.js');
  for (const gone of [
    'createTrailerRoutes', 'createTrailerDepartmentRoutes', 'createTrailerMediaRouter',
    'createTrailerMasterListRoutes', 'createTrailerAgreementRoutes',
    'sosRoutes', 'qbqRoutes', 'createQbqPageRoutes', 'mountFleet',
  ]) {
    assert.ok(!api.includes(gone), `server/api.js must not mount ${gone}`);
  }
  for (const kept of [
    'createRemoteRoutes', 'createHealthRoutes', 'createLiveLocationsRouter',
    'createRouteControlRouter', 'createHomeTimeRouter', 'createFuelMonitorRouter',
    'createSettingsRouter', 'createRecruiterRouter', 'createQuestionsRoutes',
    'createBroadcastRoutes', 'createMileageBonusRoutes', 'raisePublicRouter',
    'createRouteScreenshotMediaRouter', 'createLeadsProxyRoutes',
  ]) {
    assert.ok(api.includes(kept), `server/api.js must still mount ${kept}`);
  }
  // The removed page paths are out of the SPA catch-all and answered explicitly.
  const catchAll = /app\.get\(\[([^\]]+)\]/.exec(api);
  assert.ok(catchAll, 'the SPA catch-all must still exist');
  for (const gone of ['/trailers', '/questions', '/answers']) {
    assert.ok(!catchAll[1].includes(`'${gone}'`), `${gone} must not resolve to the admin SPA`);
  }
  assert.ok(api.includes('createRetiredRoutes'), 'the 410 responder is mounted');
});

test('no route requires a permission of a removed feature', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    if (!file.includes(`${path.sep}server${path.sep}`) && !file.includes(`${path.sep}admin${path.sep}`)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/requirePermission\(([^)]*)\)/g)) {
      if (/trailer/i.test(m[1])) offenders.push(`${path.relative(ROOT, file)}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], 'a route still gates on a removed permission');
});

test('the admin SPA has no page, nav entry or API client for a removed feature', () => {
  const app = read('admin/src/App.jsx');
  const sidebar = read('admin/src/components/AdminSidebar.jsx');
  for (const gone of ['TrailerTrackingPage', 'TrailerDepartmentShell', 'SosAdminPage',
    'SosQuestionsPage', 'SosAnswersPage', 'trailer_tracking', 'trailer_department', 'sos_admin']) {
    assert.ok(!app.includes(gone), `App.jsx must not reference ${gone}`);
    assert.ok(!sidebar.includes(gone), `AdminSidebar.jsx must not reference ${gone}`);
  }
  for (const gone of ['api/trailerTracking', 'api/trailerDepartment', 'api/trailerAgreements', 'api/sos']) {
    assert.ok(!read('admin/src/api.js').includes(gone), `the API façade must not re-export ${gone}`);
    assert.equal(exists(`admin/src/${gone}.js`), false, `admin/src/${gone}.js must stay removed`);
  }
});

test('the baseline schema creates no removed feature table, and still creates the shared ones', () => {
  const schema = read('database/schema.sql');
  const created = [...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  const removed = created.filter((t) => /^(trailer|sos_|qbq_|fleet_)/.test(t) || t === 'trailers');
  assert.deepEqual(removed, [], 'the baseline must not create a removed feature table');
  for (const kept of [
    'groups', 'drivers', 'admins', 'permissions', 'roles', 'admin_user_roles',
    'role_permissions', 'admin_audit_log', 'bol_pod_forwarding_settings',
  ]) {
    assert.ok(created.includes(kept), `the baseline must still create ${kept}`);
  }
});

test('the whole index.js module graph loads with no application env', () => {
  // No DATABASE_URL, no BOT_TOKEN, nothing: config validation happens at the
  // startup boundary, so every module must be importable without it. A
  // dangling require anywhere in the graph throws here.
  const graph = [
    'server/api.js', 'bot/bot.js', 'database/db.js',
    'services/schedulerService.js', 'services/databaseUsageService.js',
    'services/birthdayService.js', 'services/groupStatusAiService.js',
    'services/employeeBirthdayWishService.js', 'services/facebookWebhookService.js',
    'services/dispatchEtaUpdateService.js', 'services/mileageBonusService.js',
    'services/datatruckDocumentService.js', 'services/raiseApprovalService.js',
    'services/fuelStopAlertService.js', 'services/recruiterCallSyncService.js',
    'services/ringCentralTokenRefreshService.js', 'services/roadBonusNotifierService.js',
    'services/homeTimeReminderService.js', 'services/routeControlService.js',
    'services/duplicateUnitCheckService.js', 'services/memoryWatchdog.js',
    'services/leadsTelegramClient.js', 'database/retiredLeftovers.js',
  ];
  for (const rel of graph) {
    assert.doesNotThrow(
      () => require(path.join(ROOT, rel)),
      `${rel} must load with no application configuration`,
    );
  }
});
