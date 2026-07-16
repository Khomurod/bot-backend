/**
 * Destination auto-completion.
 *
 * `evaluateDestinationCompletion` is PURE and safe by construction: only active
 * assignments, only FRESH GPS and only valid destination coordinates can ever
 * return shouldComplete=true. `checkAssignmentCompletion` wraps it with the
 * bounded destination repair, the ATOMIC completion write (only the winner of
 * the race writes the audit event) and the Admin diagnostics.
 *
 * Completion deliberately needs no Google Maps config — it runs for every
 * lifecycle-active route even with the GMaps switch off.
 */
const rc = require('../../database/routeControl');
const gmaps = require('../../database/gmapsSettings');
const { haversineMeters } = require('../routeGeometry');
const { serviceError } = require('./errors');
const { nowIso } = require('./diagnostics');
const { hasFiniteCoord } = require('./geometryService');
const { maybeRepairDestinationCoordinates } = require('./destinationRepair');
const { resolveAssignmentLocation } = require('./assignmentLocation');
const { monitorSettingsFromConfig } = require('./monitorSettings');
const {
  METERS_PER_MILE,
  DEFAULT_COMPLETION_RADIUS_MILES,
  COMPLETION_EPSILON_METERS,
  COMPLETION_BLOCKED,
} = require('./constants');

/**
 * PURE. Decide whether an active route should auto-complete because the driver's
 * FRESH GPS is within the completion radius of the FINAL destination
 * (destination_lat/destination_lng — never an intermediate waypoint).
 *
 * Anything missing or stale returns false. The boundary is inclusive (exactly
 * the radius completes).
 *
 * @returns {{ shouldComplete:boolean, distanceMeters:(number|null),
 *             distanceMiles:(number|null), reason:string, code:string }}
 * `code` is a stable machine-readable classification: COMPLETED_WITHIN_RADIUS |
 * OUTSIDE_COMPLETION_RADIUS | DESTINATION_COORDINATES_MISSING |
 * LIVE_GPS_MISSING | LIVE_GPS_STALE | NOT_ACTIVE | DISTANCE_UNMEASURABLE.
 */
function evaluateDestinationCompletion({
  assignment, location, staleGpsMinutes, completionRadiusMiles,
} = {}) {
  const fail = (code, reason) => ({
    shouldComplete: false, distanceMeters: null, distanceMiles: null, reason, code,
  });

  // Only active (lifecycle) routes complete; completed/cancelled stay unchanged.
  if (!assignment || (assignment.status && assignment.status !== 'active')) {
    return fail('NOT_ACTIVE', `route is ${assignment?.status || 'missing'}`);
  }
  // Final destination coordinates must be present and valid. NOTE: null is
  // checked explicitly because Number(null) === 0 would otherwise silently
  // point a missing destination at latitude/longitude 0.
  if (!hasFiniteCoord(assignment.destination_lat) || !hasFiniteCoord(assignment.destination_lng)) {
    return fail(COMPLETION_BLOCKED.DESTINATION_COORDINATES_MISSING, 'no destination coordinates');
  }
  const dLat = Number(assignment.destination_lat);
  const dLng = Number(assignment.destination_lng);
  // GPS must exist.
  if (!location || location.latitude == null || location.longitude == null) {
    return fail(COMPLETION_BLOCKED.LIVE_GPS_MISSING, 'no GPS available');
  }
  const lat = Number(location.latitude);
  const lng = Number(location.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return fail(COMPLETION_BLOCKED.LIVE_GPS_MISSING, 'invalid GPS coordinates');
  }
  // GPS must be fresh — stale GPS must NEVER complete a route.
  const stale = Number(staleGpsMinutes);
  const ageMin = location.pingAgeMinutes;
  if (ageMin != null && Number.isFinite(Number(ageMin)) && Number.isFinite(stale) && Number(ageMin) > stale) {
    return fail(COMPLETION_BLOCKED.LIVE_GPS_STALE, `GPS is ${Math.round(Number(ageMin))}min old (> ${stale})`);
  }

  const radiusMiles = Number(completionRadiusMiles) > 0
    ? Number(completionRadiusMiles) : DEFAULT_COMPLETION_RADIUS_MILES;
  const distanceMeters = haversineMeters([lat, lng], [dLat, dLng]);
  if (distanceMeters == null || !Number.isFinite(distanceMeters)) {
    return fail('DISTANCE_UNMEASURABLE', 'could not measure distance to destination');
  }
  const distanceMiles = distanceMeters / METERS_PER_MILE;
  const radiusMeters = radiusMiles * METERS_PER_MILE;
  const shouldComplete = distanceMeters <= radiusMeters + COMPLETION_EPSILON_METERS;
  return {
    shouldComplete,
    distanceMeters,
    distanceMiles,
    code: shouldComplete ? 'COMPLETED_WITHIN_RADIUS' : COMPLETION_BLOCKED.OUTSIDE_COMPLETION_RADIUS,
    reason: shouldComplete
      ? `fresh GPS is ${distanceMiles.toFixed(1)} mi from the final destination (≤ ${radiusMiles} mi)`
      : `${distanceMiles.toFixed(1)} mi from the final destination (> ${radiusMiles} mi)`,
  };
}

/**
 * Destination-completion gate for ONE assignment with an already-resolved
 * location. Attempts a bounded coordinate repair when needed, evaluates the
 * pure completion decision, atomically completes inside the radius (exactly one
 * audit event ever — overlapping checks lose the atomic UPDATE race and write
 * nothing), and records diagnostics (distance, blocked reason) otherwise.
 *
 * @returns {{ completed:boolean, duplicate:boolean, blockedReason:(string|null),
 *             distanceMeters:(number|null), distanceMiles:(number|null) }}
 */
async function checkAssignmentCompletion(assignment, { location, resolveError = null, settings, now = new Date() }) {
  const hasCoords = hasFiniteCoord(assignment.destination_lat)
    && hasFiniteCoord(assignment.destination_lng);
  if (!hasCoords && assignment.status === 'active') {
    try { await maybeRepairDestinationCoordinates(assignment); } catch (_) { /* diagnosed below */ }
  }

  const completion = evaluateDestinationCompletion({
    assignment, location,
    staleGpsMinutes: settings.staleGpsMinutes,
    completionRadiusMiles: settings.completionRadiusMiles,
  });

  if (completion.shouldComplete) {
    const detail = `Auto-completed: fresh GPS was ${completion.distanceMiles.toFixed(1)} miles from the final destination`
      + ` (radius ${settings.completionRadiusMiles} mi, GPS age ${location.pingAgeMinutes != null ? `${Math.round(Number(location.pingAgeMinutes))}min` : 'unknown'}).`;
    const done = await rc.completeRouteAssignment(assignment.id, {
      latitude: location.latitude,
      longitude: location.longitude,
      distanceMeters: completion.distanceMeters,
      reason: detail,
    });
    // done === null → another overlapping check already completed it: no
    // duplicate event, no double-processing.
    if (done) {
      await rc.insertRouteMonitorEvent({
        assignmentId: assignment.id,
        eventType: 'destination_reached',
        result: 'completed',
        latitude: location.latitude,
        longitude: location.longitude,
        deviationMeters: completion.distanceMeters,
        detail,
      });
    }
    return {
      completed: true, duplicate: !done, blockedReason: null,
      distanceMeters: completion.distanceMeters, distanceMiles: completion.distanceMiles,
    };
  }

  // Not completed — classify why, for the Admin diagnostics. A GPS resolution
  // failure (unit unparseable / ambiguous / provider error) beats the generic
  // "no GPS" so the admin sees the actionable cause.
  let blockedReason = completion.code;
  if (blockedReason === COMPLETION_BLOCKED.LIVE_GPS_MISSING && resolveError) {
    blockedReason = COMPLETION_BLOCKED.UNIT_RESOLUTION_FAILED;
  }
  try {
    await rc.updateCompletionDiagnostics(assignment.id, {
      lastCompletionCheckAt: nowIso(now),
      distanceMeters: completion.distanceMeters,
      blockedReason,
    });
  } catch (_) { /* diagnostics must never break monitoring */ }
  return {
    completed: false, duplicate: false, blockedReason,
    distanceMeters: completion.distanceMeters, distanceMiles: completion.distanceMiles,
  };
}

/** Tally a completion blocked-reason into the monitor summary counters. */
function tallyBlockedReason(summary, blockedReason) {
  if (blockedReason === COMPLETION_BLOCKED.OUTSIDE_COMPLETION_RADIUS) summary.outside_radius += 1;
  else if (blockedReason === COMPLETION_BLOCKED.DESTINATION_COORDINATES_MISSING) summary.missing_destination += 1;
  else if (blockedReason === COMPLETION_BLOCKED.LIVE_GPS_STALE) summary.stale_gps += 1;
  else if (blockedReason === COMPLETION_BLOCKED.UNIT_RESOLUTION_FAILED) summary.resolution_errors += 1;
  else if (blockedReason === COMPLETION_BLOCKED.LIVE_GPS_MISSING) summary.missing_gps += 1;
}

// Guard against overlapping MANUAL completion runs. Overlap with the monitor
// tick is already safe because completion is an atomic conditional UPDATE.
let completionCheckRunning = false;

/**
 * Idempotent completion-only reconciliation over existing routes — the "Run
 * completion check now" admin action (optionally scoped to one assignment).
 * Resolves GPS, repairs destinations (bounded), completes routes inside the
 * radius and reports a per-route diagnostic. NEVER sends off-route warnings and
 * never touches tracking state, so it is safe to run at any time.
 */
async function runCompletionCheckNow({ assignmentId = null, now = new Date() } = {}) {
  if (completionCheckRunning) return { alreadyRunning: true, results: [] };
  completionCheckRunning = true;
  try {
    let cfg = null;
    try { cfg = await gmaps.getGmapsConfig(); } catch (_) { cfg = null; }
    const settings = monitorSettingsFromConfig(cfg || {});

    let assignments;
    if (assignmentId != null) {
      const one = await rc.getRouteAssignment(assignmentId);
      if (!one) throw serviceError('NOT_FOUND', 'Route assignment not found.', 404);
      if (one.status !== 'active') {
        return {
          alreadyRunning: false,
          completionRadiusMiles: settings.completionRadiusMiles,
          results: [{ id: one.id, completed: false, blockedReason: null, note: `route is ${one.status}` }],
        };
      }
      assignments = [one];
    } else {
      assignments = await rc.listActiveAssignmentsForMonitor();
    }

    const results = [];
    for (const assignment of assignments) {
      try {
        const { location, source, error: resolveError } = await resolveAssignmentLocation(assignment);
        const gate = await checkAssignmentCompletion(assignment, { location, resolveError, settings, now });
        results.push({
          id: assignment.id,
          groupName: assignment.group_name || null,
          completed: gate.completed,
          blockedReason: gate.blockedReason,
          distanceMeters: gate.distanceMeters,
          distanceMiles: gate.distanceMiles != null ? Number(gate.distanceMiles.toFixed(1)) : null,
          gpsSource: source,
          gpsAgeMinutes: location?.pingAgeMinutes ?? null,
          resolveError: resolveError ? String(resolveError.message || resolveError).slice(0, 200) : null,
        });
      } catch (err) {
        results.push({ id: assignment.id, completed: false, error: String(err.message || err).slice(0, 200) });
      }
    }
    return {
      alreadyRunning: false,
      completionRadiusMiles: settings.completionRadiusMiles,
      results,
    };
  } finally {
    completionCheckRunning = false;
  }
}

module.exports = {
  evaluateDestinationCompletion,
  checkAssignmentCompletion,
  tallyBlockedReason,
  runCompletionCheckNow,
};
