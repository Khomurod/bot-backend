/**
 * Route MONITORING state — database helpers.
 *
 * The queries the Route Control monitor sweeps on each tick: which assignments
 * are live, which are waiting for tracking to be activated, and the per-tick
 * state it writes back (last check, off-route warning bookkeeping, completion
 * diagnostics).
 *
 * THE TICK NAMES ITS COLUMNS AND READS NOTHING BACK FROM A WRITE. It runs every
 * five minutes for the life of the process, and in October 2026 it was reading
 * whole 62-column rows and echoing each write with `RETURNING *` — about 4 MB
 * of the database's monthly transfer allowance a day per tracked route. Where
 * another caller still wants the row back (`activateTracking`), the tick has
 * its own narrow variant beside it rather than a changed contract.
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
 *
 * WHOLE ROWS, for the admin "Run completion check now". The monitor tick reads
 * the same set through listMonitorPassAssignments.
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
 * What the monitor pass — and everything it calls — reads from a route, traced
 * field by field: live GPS (unit_number, group_id, group_name), the completion
 * gate and its repair (status, destination_*, the repair budget), the start of
 * tracking (tracking_*, driver_group_message_sent_at), the off-route decision
 * (consecutive_off_route, last_notification_at) and where a warning goes
 * (telegram_group_id).
 *
 * NOT the polyline, the largest column: only an off-route check or the repair
 * of a missing destination needs it. Its md5 comes instead (NULL when there is
 * none), so services/routeControl/routePolyline.js can fetch it on demand and
 * keep it until it changes. `updated_at` could not serve as that version —
 * every monitor write moves it.
 */
const MONITOR_PASS_COLUMNS = `r.id, r.group_id, r.unit_number, r.status,
       r.tracking_status, r.tracking_start_mode, r.tracking_start_at, r.tracking_start_lat,
       r.tracking_start_lng, r.tracking_start_radius_miles, r.tracking_hold_reason,
       r.driver_group_message_sent_at, r.destination_lat, r.destination_lng, r.destination_text,
       r.destination_repair_attempts, r.destination_repair_last_at,
       r.consecutive_off_route, r.last_notification_at,
       md5(r.encoded_polyline) AS polyline_version,
       g.group_name, g.telegram_group_id`;

/**
 * The monitor tick's read: the same routes in the same order as
 * listActiveAssignmentsForMonitor, narrowed to MONITOR_PASS_COLUMNS.
 *
 * It asks with ONE column first. Describing the pass's 22 columns costs about
 * 0.8 KB whether or not a row comes back, and with no route active that was the
 * whole answer, every five minutes.
 */
async function listMonitorPassAssignments() {
  const any = await query(`SELECT id FROM route_assignments WHERE status = 'active' LIMIT 1`);
  if (!any.rows.length) return [];
  const res = await query(
    `SELECT ${MONITOR_PASS_COLUMNS}
     FROM route_assignments r
     LEFT JOIN groups g ON g.id = r.group_id
     WHERE r.status = 'active'
     ORDER BY r.updated_at ASC`
  );
  return res.rows;
}

/** One route's polyline, with the same md5 fingerprint the pass reads; null when the route is gone. */
async function getAssignmentPolyline(id) {
  const res = await query(
    `SELECT encoded_polyline, md5(encoded_polyline) AS polyline_version
       FROM route_assignments WHERE id = $1`,
    [id]
  );
  return res.rows[0] || null;
}

/**
 * The unit number on a group's driver profile — all that GPS resolution needs
 * when a route has none stored, where the shared getDriverProfileByGroupId
 * reads the whole profile. (A profile cannot outlive its group — the foreign
 * key cascades — so that read's JOIN on groups never filters anything here.)
 */
async function getProfileUnitNumberForGroup(groupId) {
  const res = await query('SELECT unit_number FROM driver_profiles WHERE group_id = $1 LIMIT 1', [groupId]);
  return res.rows[0]?.unit_number ?? null;
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

const ACTIVATE_TRACKING_SQL = `UPDATE route_assignments
       SET tracking_status = 'active',
           tracking_started_at = COALESCE(tracking_started_at, NOW()),
           tracking_hold_reason = NULL,
           updated_at = NOW()
     WHERE id = $1 AND tracking_status <> 'active'`;

/** Flip tracking to active (idempotent) and stamp when it started. */
async function activateTracking(id) {
  const res = await query(`${ACTIVATE_TRACKING_SQL} RETURNING *`, [id]);
  return res.rows[0] || null;
}

/** The monitor's variant of activateTracking: the same flip, and nothing read back. */
async function activatePendingTracking(id) {
  await query(ACTIVATE_TRACKING_SQL, [id]);
}

/** Update the machine-readable reason an assignment's tracking is on hold. Reads nothing back. */
async function setTrackingHoldReason(id, reason) {
  await query(
    `UPDATE route_assignments
       SET tracking_hold_reason = $2, updated_at = NOW()
     WHERE id = $1`,
    [id, reason ? String(reason).slice(0, 64) : null]
  );
}

/** Record the outcome of one monitoring check (state fields only). Reads nothing back. */
async function updateRouteAssignmentMonitorState(id, {
  lastCheckedAt, lastLatitude, lastLongitude, lastDeviationMeters,
  lastCheckResult, consecutiveOffRoute, lastNotificationAt,
}) {
  await query(
    `UPDATE route_assignments
       SET last_checked_at = $2,
           last_latitude = $3,
           last_longitude = $4,
           last_deviation_meters = $5,
           last_check_result = $6,
           consecutive_off_route = $7,
           last_notification_at = COALESCE($8, last_notification_at),
           updated_at = NOW()
     WHERE id = $1`,
    [
      id, lastCheckedAt || null, lastLatitude ?? null, lastLongitude ?? null,
      lastDeviationMeters ?? null, lastCheckResult || null,
      Math.max(0, Number(consecutiveOffRoute) || 0), lastNotificationAt || null,
    ]
  );
}

/**
 * Record the outcome of one destination-completion check: when it ran, the
 * measured distance to the final destination (NULL when unmeasurable), and a
 * machine-readable reason the route did not complete (NULL once completed).
 * Reads nothing back — it runs for every active route on every tick.
 */
async function updateCompletionDiagnostics(id, {
  lastCompletionCheckAt = null, distanceMeters = null, blockedReason = null,
} = {}) {
  await query(
    `UPDATE route_assignments
       SET last_completion_check_at = COALESCE($2, NOW()),
           last_destination_distance_meters = $3,
           completion_blocked_reason = $4,
           updated_at = NOW()
     WHERE id = $1`,
    [
      id, lastCompletionCheckAt || null,
      distanceMeters != null && Number.isFinite(Number(distanceMeters)) ? Number(distanceMeters) : null,
      blockedReason ? String(blockedReason).slice(0, 64) : null,
    ]
  );
}

module.exports = {
  listActiveAssignmentsForMonitor,
  listMonitorPassAssignments,
  getAssignmentPolyline,
  getProfileUnitNumberForGroup,
  listMonitorableAssignments,
  listPendingTrackingAssignments,
  activateTracking,
  activatePendingTracking,
  setTrackingHoldReason,
  updateRouteAssignmentMonitorState,
  updateCompletionDiagnostics,
};
