/**
 * Off-route deviation decisions.
 *
 * `evaluateAssignment` is PURE (no DB / network / Telegram) so the grace-count,
 * cooldown, parked and stale-GPS rules are unit-tested deterministically. The
 * monitor loop is a thin wrapper around it.
 */
const { decodePolyline, distancePointToPolylineMeters } = require('../routeGeometry');

/**
 * PURE. Decide the outcome of one monitoring check for an assignment.
 *
 * @returns {{ result:string, deviationMeters:(number|null),
 *             consecutiveOffRoute:number, shouldNotify:boolean, reason:string }}
 * result ∈ on_route | off_route | parked | stale | not_checked | no_geometry | not_monitored
 */
function evaluateAssignment({ assignment, location, settings, now = new Date() }) {
  const prev = Math.max(0, Number(assignment?.consecutive_off_route) || 0);
  const base = { deviationMeters: null, consecutiveOffRoute: prev, shouldNotify: false };

  // Completed / cancelled routes are never monitored.
  if (assignment?.status && assignment.status !== 'active') {
    return { ...base, result: 'not_monitored', reason: `route is ${assignment.status}` };
  }
  // Tracking hasn't started yet (waiting for message / time / location) —
  // deviation checks are skipped until the start condition is met.
  if (assignment?.tracking_status === 'pending') {
    return { ...base, result: 'not_monitored', reason: 'tracking has not started yet' };
  }
  const polyline = decodePolyline(assignment?.encoded_polyline || '');
  if (!polyline.length) {
    return { ...base, result: 'no_geometry', reason: 'no route geometry to compare against' };
  }
  // Missing / unavailable GPS → do not warn.
  if (!location || location.latitude == null || location.longitude == null) {
    return { ...base, result: 'not_checked', reason: 'no GPS available' };
  }
  // Stale GPS → do not warn.
  const ageMin = location.pingAgeMinutes;
  if (ageMin != null && Number.isFinite(Number(ageMin)) && Number(ageMin) > settings.staleGpsMinutes) {
    return { ...base, result: 'stale', reason: `GPS is ${Math.round(Number(ageMin))}min old (> ${settings.staleGpsMinutes})` };
  }

  const deviationMeters = distancePointToPolylineMeters(
    [location.latitude, location.longitude], polyline
  );
  if (deviationMeters == null) {
    return { ...base, result: 'not_checked', reason: 'could not measure deviation' };
  }

  // On route → reset the off-route streak.
  if (deviationMeters <= settings.deviationThresholdMeters) {
    return {
      result: 'on_route', deviationMeters, consecutiveOffRoute: 0, shouldNotify: false, reason: 'within threshold',
    };
  }

  // Off route but parked / crawling → likely a legitimate stop, don't escalate.
  const speed = location.speedMilesPerHour;
  if (speed != null && Number.isFinite(Number(speed)) && Number(speed) <= settings.parkedSpeedMph) {
    return {
      result: 'parked', deviationMeters, consecutiveOffRoute: prev, shouldNotify: false,
      reason: `off route but parked/slow (${speed} mph)`,
    };
  }

  // Off route and moving → count a consecutive miss.
  const consecutiveOffRoute = prev + 1;
  if (consecutiveOffRoute < settings.offRouteGraceChecks) {
    return {
      result: 'off_route', deviationMeters, consecutiveOffRoute, shouldNotify: false,
      reason: `off route ${consecutiveOffRoute}/${settings.offRouteGraceChecks} (within grace)`,
    };
  }
  // Past the grace threshold — respect the warning cooldown.
  const cooldownMs = settings.warningCooldownMinutes * 60 * 1000;
  const lastNotif = assignment.last_notification_at
    ? new Date(assignment.last_notification_at).getTime() : 0;
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  if (lastNotif && nowMs - lastNotif < cooldownMs) {
    return {
      result: 'off_route', deviationMeters, consecutiveOffRoute, shouldNotify: false,
      reason: 'off route but within warning cooldown',
    };
  }
  return {
    result: 'off_route', deviationMeters, consecutiveOffRoute, shouldNotify: true,
    reason: 'off route beyond grace, cooldown elapsed',
  };
}

module.exports = { evaluateAssignment };
