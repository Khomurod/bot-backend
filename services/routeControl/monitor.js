/**
 * The Route Control monitor loop and its timer.
 *
 * OWNER of the service timer state (`serviceTimer`, `serviceStopped`,
 * `tickRunning`, `telegramClient`, `currentIntervalMs`) — the only long-lived
 * mutable state outside the editor's in-flight guard, and it lives here because
 * this is the only module that schedules work.
 *
 * Two independent concerns run in the pass, with different gates:
 *   1. DESTINATION AUTO-COMPLETION — needs only stored destination coordinates,
 *      live ELD GPS and a haversine distance. It runs for EVERY lifecycle-active
 *      route (tracking active OR pending) and does NOT require Google Maps to be
 *      enabled: existing routes keep completing even with the GMaps switch off.
 *      Completion is silent (no driver-group message) and atomic.
 *   2. OFF-ROUTE WARNINGS — need computed route geometry, so they stay gated on
 *      Settings → GMaps `enabled` and only run for tracking-active routes.
 */
const rc = require('../../database/routeControl');
const gmaps = require('../../database/gmapsSettings');
const { safeSend } = require('../telegramHtml');
const { nowIso } = require('./diagnostics');
const { buildOffRouteMessage } = require('./messageFormatter');
const { evaluateAssignment } = require('./deviationMonitor');
const { monitorSettingsFromConfig } = require('./monitorSettings');
const { resolveAssignmentLocation } = require('./assignmentLocation');
const { checkAssignmentCompletion, tallyBlockedReason } = require('./completionService');
const { evaluateTrackingStart } = require('./trackingStartService');
const { POLL_MS_MIN } = require('./constants');

let serviceTimer = null;
let serviceStopped = false;
let tickRunning = false;
let telegramClient = null;
let currentIntervalMs = POLL_MS_MIN;

/** Handle the PENDING branch of a monitor pass: start tracking, or update the hold reason. */
async function processPendingTracking(assignment, { location, now }) {
  const startVerdict = evaluateTrackingStart({ assignment, location, now });
  if (startVerdict.shouldStart) {
    await rc.activateTracking(assignment.id);
    await rc.insertRouteMonitorEvent({
      assignmentId: assignment.id,
      eventType: 'tracking_started',
      latitude: location?.latitude,
      longitude: location?.longitude,
      detail: startVerdict.reason,
    });
    return { activated: true };
  }
  if ((assignment.tracking_hold_reason || null) !== (startVerdict.holdReason || null)) {
    await rc.setTrackingHoldReason(assignment.id, startVerdict.holdReason);
    await rc.insertRouteMonitorEvent({
      assignmentId: assignment.id,
      eventType: `tracking_start_${startVerdict.holdReason || 'pending'}`,
      detail: startVerdict.reason,
    });
  }
  return { activated: false };
}

/** Handle the ACTIVE-tracking branch: evaluate deviation, persist, warn. */
async function processDeviationCheck(assignment, { location, settings, now, telegram }) {
  const verdict = evaluateAssignment({ assignment, location, settings, now });

  await rc.updateRouteAssignmentMonitorState(assignment.id, {
    lastCheckedAt: nowIso(now),
    lastLatitude: location?.latitude ?? null,
    lastLongitude: location?.longitude ?? null,
    lastDeviationMeters: verdict.deviationMeters,
    lastCheckResult: verdict.result,
    consecutiveOffRoute: verdict.consecutiveOffRoute,
    lastNotificationAt: verdict.shouldNotify ? nowIso(now) : null,
  });
  await rc.insertRouteMonitorEvent({
    assignmentId: assignment.id,
    eventType: verdict.shouldNotify ? 'notification' : 'check',
    result: verdict.result,
    latitude: location?.latitude,
    longitude: location?.longitude,
    deviationMeters: verdict.deviationMeters,
    detail: verdict.reason,
  });

  if (verdict.shouldNotify && telegram && assignment.telegram_group_id) {
    await safeSend(() => telegram.sendMessage(
      assignment.telegram_group_id,
      buildOffRouteMessage(assignment, verdict),
      { disable_web_page_preview: true }
    ));
    return { notified: true };
  }
  return { notified: false };
}

/**
 * One monitoring pass over EVERY lifecycle-active assignment (tracking active
 * AND pending). Per assignment, in order:
 *   1. Resolve live GPS once (stored unit number preferred).
 *   2. Destination auto-completion FIRST — runs for every route, needs no
 *      Google Maps config, and short-circuits everything else when it fires.
 *   3. Pending tracking → evaluate the start condition (never warnings).
 *   4. Active tracking → off-route deviation checks, gated on Settings → GMaps.
 */
async function runRouteMonitorCheck(telegram, { now = new Date() } = {}) {
  let cfg = null;
  try { cfg = await gmaps.getGmapsConfig(); } catch (_) { cfg = null; }
  const settings = monitorSettingsFromConfig(cfg || {});
  const offRouteMonitoringEnabled = Boolean(cfg && cfg.enabled);

  let assignments = [];
  try {
    assignments = await rc.listActiveAssignmentsForMonitor();
  } catch (err) {
    console.error('[ROUTE-CONTROL] Could not load active assignments:', err.message);
    return { enabled: offRouteMonitoringEnabled, checked: 0, notified: 0, activated: 0, completed: 0 };
  }

  const summary = {
    eligible: assignments.length, completed: 0, outside_radius: 0, missing_destination: 0,
    missing_gps: 0, stale_gps: 0, resolution_errors: 0, warnings_sent: 0,
  };
  let checked = 0;
  let notified = 0;
  let activated = 0;
  let completed = 0;

  for (const assignment of assignments) {
    try {
      const { location, error: resolveError } = await resolveAssignmentLocation(assignment);

      // 1) Destination auto-completion — before ANY off-route logic. A completed
      // route sends no message, is excluded from every later pass, and can never
      // warn again.
      const gate = await checkAssignmentCompletion(assignment, { location, resolveError, settings, now });
      if (gate.completed) {
        if (!gate.duplicate) { completed += 1; summary.completed += 1; }
        continue;
      }
      tallyBlockedReason(summary, gate.blockedReason);

      // 2) Pending tracking: evaluate the start condition only. Pending routes
      // NEVER receive off-route warnings (evaluateAssignment also guards this).
      if (assignment.tracking_status === 'pending') {
        const r = await processPendingTracking(assignment, { location, now });
        if (r.activated) activated += 1;
        continue;
      }

      // 3) Off-route deviation checks — the Google-geometry feature, still gated
      // on Settings → GMaps. Completion above already ran regardless.
      if (!offRouteMonitoringEnabled) continue;
      checked += 1;
      const r = await processDeviationCheck(assignment, { location, settings, now, telegram });
      if (r.notified) { notified += 1; summary.warnings_sent += 1; }
    } catch (err) {
      console.error(`[ROUTE-CONTROL] Check failed for assignment #${assignment.id}:`, err.message);
    }
  }
  if (assignments.length) {
    console.log(
      `[ROUTE-CONTROL] eligible=${summary.eligible} completed=${summary.completed}`
      + ` outside_radius=${summary.outside_radius} missing_destination=${summary.missing_destination}`
      + ` missing_gps=${summary.missing_gps} stale_gps=${summary.stale_gps}`
      + ` resolution_errors=${summary.resolution_errors} warnings_sent=${summary.warnings_sent}`
    );
  }
  return { enabled: offRouteMonitoringEnabled, checked, notified, activated, completed, summary };
}

/** Read the admin-configured check interval, floored at POLL_MS_MIN. */
async function resolveIntervalMs() {
  const cfg = await gmaps.getGmapsConfig();
  return Math.max(POLL_MS_MIN, (cfg.checkIntervalSeconds || 300) * 1000);
}

async function tick() {
  if (tickRunning || !telegramClient) return;
  tickRunning = true;
  try {
    await runRouteMonitorCheck(telegramClient);
  } catch (err) {
    console.error('[ROUTE-CONTROL] Monitor tick error:', err.message);
  } finally {
    tickRunning = false;
  }
  // Pick up an admin-changed check interval without a restart (single timer —
  // the old one is always cleared before a new one is created).
  await maybeRescheduleTimer().catch(() => {});
}

async function maybeRescheduleTimer() {
  if (serviceStopped || !serviceTimer) return;
  let intervalMs;
  try {
    intervalMs = await resolveIntervalMs();
  } catch (_) { return; }
  if (intervalMs === currentIntervalMs || serviceStopped || !serviceTimer) return;
  clearInterval(serviceTimer);
  currentIntervalMs = intervalMs;
  serviceTimer = setInterval(() => { if (!serviceStopped) tick(); }, intervalMs);
  serviceTimer.unref?.();
  console.log(`[ROUTE-CONTROL] Check interval updated — monitoring every ${Math.round(intervalMs / 1000)}s`);
}

async function startRouteControlService(telegram) {
  if (telegram) telegramClient = telegram;
  serviceStopped = false;
  // Never leave two timers running if start is called twice (e.g. a re-init).
  if (serviceTimer) { clearInterval(serviceTimer); serviceTimer = null; }
  let intervalMs = POLL_MS_MIN;
  try {
    intervalMs = await resolveIntervalMs();
  } catch (_) { /* use default */ }
  currentIntervalMs = intervalMs;
  console.log(`[ROUTE-CONTROL] Service started — monitoring every ${Math.round(intervalMs / 1000)}s`
    + ' (destination completion always on; off-route warnings gated on Settings → GMaps)');
  // First pass ~25s after boot doubles as the existing-route reconciliation:
  // every lifecycle-active route (tracking active OR pending) gets a completion
  // check, so routes already inside the radius complete on startup.
  setTimeout(() => { if (!serviceStopped) tick(); }, 25 * 1000).unref?.();
  serviceTimer = setInterval(() => { if (!serviceStopped) tick(); }, intervalMs);
  serviceTimer.unref?.();
}

function stopRouteControlService() {
  serviceStopped = true;
  if (serviceTimer) {
    clearInterval(serviceTimer);
    serviceTimer = null;
  }
}

module.exports = {
  runRouteMonitorCheck,
  tick,
  startRouteControlService,
  stopRouteControlService,
};
