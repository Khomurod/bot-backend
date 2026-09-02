/**
 * Route MONITORING state — database helpers.
 *
 * The queries the Route Control monitor sweeps on each tick: which assignments
 * are live, which are waiting for tracking to be activated, and the per-tick
 * state it writes back (last check, off-route warning bookkeeping, completion
 * diagnostics).
 *
 * Split out of database/routeControl.js, which re-exports every symbol here.
 */
const { query } = require('../pool');

/**
 * EVERY lifecycle-active assignment, regardless of tracking status — the single
 * candidate set the monitor sweeps each pass. Destination auto-completion
 * applies to all of them (including tracking-pending routes, which must be able
 * to complete without ever receiving off-route warnings); off-route deviation
 * checks additionally require tracking_status='active' + geometry and are
 * decided in the service. LEFT JOIN so a route whose group row was deleted
 * still surfaces with a diagnostic instead of silently vanishing.
 */
async function listActiveAssignmentsForMonitor() {
  const res = await query(
    `SELECT r.*, g.group_name, g.telegram_group_id, g.active AS group_active
     FROM route_assignments r
     LEFT JOIN groups g ON g.id = r.group_id
     WHERE r.status = 'active'
     ORDER BY r.updated_at ASC`
  );
  return res.rows;
}

/**
 * Active assignments whose tracking has started — the ones the monitor evaluates
 * each pass. A route is eligible when it EITHER has route geometry (off-route
 * deviation checks) OR has final-destination coordinates (auto-completion is
 * possible even when geometry is unavailable). Completion is checked before any
 * off-route logic, so a destination-only route can still complete.
 */
async function listMonitorableAssignments() {
  const res = await query(
    `SELECT r.*, g.group_name, g.telegram_group_id, g.active AS group_active
     FROM route_assignments r
     JOIN groups g ON g.id = r.group_id
     WHERE r.status = 'active'
       AND r.tracking_status = 'active'
       AND (r.encoded_polyline IS NOT NULL
            OR (r.destination_lat IS NOT NULL AND r.destination_lng IS NOT NULL))
     ORDER BY r.updated_at ASC`
  );
  return res.rows;
}

/**
 * Active assignments whose tracking is still PENDING — the monitor evaluates
 * their start condition (message sent / scheduled time / start location) each
 * pass instead of running deviation checks.
 */
async function listPendingTrackingAssignments() {
  const res = await query(
    `SELECT r.*, g.group_name, g.telegram_group_id, g.active AS group_active
     FROM route_assignments r
     JOIN groups g ON g.id = r.group_id
     WHERE r.status = 'active' AND r.tracking_status = 'pending'
     ORDER BY r.updated_at ASC`
  );
  return res.rows;
}

/** Flip tracking to active (idempotent) and stamp when it started. */
async function activateTracking(id) {
  const res = await query(
    `UPDATE route_assignments
       SET tracking_status = 'active',
           tracking_started_at = COALESCE(tracking_started_at, NOW()),
           tracking_hold_reason = NULL,
           updated_at = NOW()
     WHERE id = $1 AND tracking_status <> 'active'
     RETURNING *`,
    [id]
  );
  return res.rows[0] || null;
}

/** Update the machine-readable reason an assignment's tracking is on hold. */
async function setTrackingHoldReason(id, reason) {
  const res = await query(
    `UPDATE route_assignments
       SET tracking_hold_reason = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, reason ? String(reason).slice(0, 64) : null]
  );
  return res.rows[0] || null;
}

/** Record the outcome of one monitoring check (state fields only). */
async function updateRouteAssignmentMonitorState(id, {
  lastCheckedAt, lastLatitude, lastLongitude, lastDeviationMeters,
  lastCheckResult, consecutiveOffRoute, lastNotificationAt,
}) {
  const res = await query(
    `UPDATE route_assignments
       SET last_checked_at = $2,
           last_latitude = $3,
           last_longitude = $4,
           last_deviation_meters = $5,
           last_check_result = $6,
           consecutive_off_route = $7,
           last_notification_at = COALESCE($8, last_notification_at),
           updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [
      id, lastCheckedAt || null, lastLatitude ?? null, lastLongitude ?? null,
      lastDeviationMeters ?? null, lastCheckResult || null,
      Math.max(0, Number(consecutiveOffRoute) || 0), lastNotificationAt || null,
    ]
  );
  return res.rows[0] || null;
}

/**
 * Record the outcome of one destination-completion check: when it ran, the
 * measured distance to the final destination (NULL when unmeasurable), and a
 * machine-readable reason the route did not complete (NULL once completed).
 */
async function updateCompletionDiagnostics(id, {
  lastCompletionCheckAt = null, distanceMeters = null, blockedReason = null,
} = {}) {
  const res = await query(
    `UPDATE route_assignments
       SET last_completion_check_at = COALESCE($2, NOW()),
           last_destination_distance_meters = $3,
           completion_blocked_reason = $4,
           updated_at = NOW()
     WHERE id = $1 RETURNING id`,
    [
      id, lastCompletionCheckAt || null,
      distanceMeters != null && Number.isFinite(Number(distanceMeters)) ? Number(distanceMeters) : null,
      blockedReason ? String(blockedReason).slice(0, 64) : null,
    ]
  );
  return res.rows[0] || null;
}

module.exports = {
  listActiveAssignmentsForMonitor,
  listMonitorableAssignments,
  listPendingTrackingAssignments,
  activateTracking,
  setTrackingHoldReason,
  updateRouteAssignmentMonitorState,
  updateCompletionDiagnostics,
};
