/**
 * Route ASSIGNMENTS — database helpers.
 *
 * One row per route: the Google Maps directions link tied to a driver group,
 * plus the geometry resolved from it and the assignment's lifecycle status.
 * The monitoring state those rows are swept for lives in ./monitorState.js.
 *
 * Split out of database/routeControl.js, which re-exports every symbol here.
 */
const { query } = require('../pool');

function toJson(value) {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

async function createRouteAssignment({
  groupId, driverProfileId, driverLabel, unitNumber, originalUrl,
  originText, destinationText, waypoints,
  originLat, originLng, destinationLat, destinationLng,
  encodedPolyline, distanceMeters, durationSeconds, assignedBy,
  source = 'admin', assignedByUserId = null, telegramChatId = null, telegramMessageId = null,
  // Tracking start controls (see schema comments). Defaults preserve the
  // pre-feature behaviour: monitoring starts immediately.
  trackingStatus = 'active', trackingStartMode = 'immediate', trackingStartAt = null,
  trackingStartLat = null, trackingStartLng = null, trackingStartLocationText = null,
  trackingStartRadiusMiles = null, trackingHoldReason = null,
}) {
  const res = await query(
    `INSERT INTO route_assignments
       (group_id, driver_profile_id, driver_label, unit_number, original_url,
        origin_text, destination_text, waypoints,
        origin_lat, origin_lng, destination_lat, destination_lng,
        encoded_polyline, distance_meters, duration_seconds, assigned_by,
        source, assigned_by_user_id, telegram_chat_id, telegram_message_id,
        tracking_status, tracking_start_mode, tracking_start_at,
        tracking_started_at,
        tracking_start_lat, tracking_start_lng, tracking_start_location_text,
        tracking_start_radius_miles, tracking_hold_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             $21,$22,$23,
             CASE WHEN $21 = 'active' THEN NOW() ELSE NULL END,
             $24,$25,$26,$27,$28)
     RETURNING *`,
    [
      groupId || null, driverProfileId || null, driverLabel || null, unitNumber || null,
      originalUrl, originText || null, destinationText || null, toJson(waypoints),
      originLat ?? null, originLng ?? null, destinationLat ?? null, destinationLng ?? null,
      encodedPolyline || null, distanceMeters ?? null, durationSeconds ?? null, assignedBy || null,
      source || 'admin', assignedByUserId ?? null, telegramChatId ?? null, telegramMessageId ?? null,
      trackingStatus || 'active', trackingStartMode || 'immediate', trackingStartAt ?? null,
      trackingStartLat ?? null, trackingStartLng ?? null, trackingStartLocationText ?? null,
      trackingStartRadiusMiles ?? null, trackingHoldReason ?? null,
    ]
  );
  return res.rows[0];
}

/** The current active assignment for a driver group (most recent), if any. */
async function getActiveRouteAssignmentByGroupId(groupId) {
  const res = await query(
    `SELECT r.*, g.group_name, g.telegram_group_id, g.active AS group_active
       FROM route_assignments r
       LEFT JOIN groups g ON g.id = r.group_id
      WHERE r.group_id = $1 AND r.status = 'active'
      ORDER BY r.updated_at DESC LIMIT 1`,
    [groupId]
  );
  return res.rows[0] || null;
}

/** Restart-safe dedupe: has this exact Telegram message already produced an assignment? */
async function findRouteAssignmentByTelegramMessage(telegramChatId, telegramMessageId) {
  if (telegramChatId == null || telegramMessageId == null) return null;
  const res = await query(
    `SELECT * FROM route_assignments
      WHERE telegram_chat_id = $1 AND telegram_message_id = $2 LIMIT 1`,
    [telegramChatId, telegramMessageId]
  );
  return res.rows[0] || null;
}

// Flags whether a route screenshot exists WITHOUT selecting its bytes.
const HAS_SCREENSHOT_SQL = `EXISTS(
      SELECT 1 FROM route_assignment_attachments att
       WHERE att.assignment_id = r.id AND att.kind = 'route_screenshot'
    ) AS has_screenshot`;

async function getRouteAssignment(id) {
  const res = await query(
    `SELECT r.*, g.group_name, g.telegram_group_id, g.active AS group_active,
            ${HAS_SCREENSHOT_SQL}
     FROM route_assignments r
     LEFT JOIN groups g ON g.id = r.group_id
     WHERE r.id = $1`,
    [id]
  );
  return res.rows[0] || null;
}

async function listRouteAssignments({ status = null, limit = 200 } = {}) {
  const clauses = [];
  const values = [];
  let i = 1;
  if (status) { clauses.push(`r.status = $${i++}`); values.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(limit);
  const res = await query(
    `SELECT r.*, g.group_name, g.telegram_group_id, g.active AS group_active,
            ${HAS_SCREENSHOT_SQL}
     FROM route_assignments r
     LEFT JOIN groups g ON g.id = r.group_id
     ${where}
     ORDER BY r.updated_at DESC
     LIMIT $${i}`,
    values
  );
  return res.rows;
}

/** Persist a computed route onto an existing assignment. */
async function setRouteAssignmentGeometry(id, {
  originText, destinationText, waypoints,
  originLat, originLng, destinationLat, destinationLng,
  encodedPolyline, distanceMeters, durationSeconds,
}) {
  const res = await query(
    `UPDATE route_assignments
       SET origin_text = COALESCE($2, origin_text),
           destination_text = COALESCE($3, destination_text),
           waypoints = $4::jsonb,
           origin_lat = $5, origin_lng = $6,
           destination_lat = $7, destination_lng = $8,
           encoded_polyline = $9, distance_meters = $10, duration_seconds = $11,
           updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [
      id, originText || null, destinationText || null, toJson(waypoints),
      originLat ?? null, originLng ?? null, destinationLat ?? null, destinationLng ?? null,
      encodedPolyline || null, distanceMeters ?? null, durationSeconds ?? null,
    ]
  );
  return res.rows[0] || null;
}

/** Persist repaired final-destination coordinates (from text parse / geocoding). */
async function setRouteAssignmentDestinationCoords(id, { lat, lng }) {
  const res = await query(
    `UPDATE route_assignments
       SET destination_lat = $2, destination_lng = $3, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, Number(lat), Number(lng)]
  );
  return res.rows[0] || null;
}

/** Count a destination-repair attempt (bounded retries — never every tick). */
async function recordDestinationRepairAttempt(id) {
  const res = await query(
    `UPDATE route_assignments
       SET destination_repair_attempts = destination_repair_attempts + 1,
           destination_repair_last_at = NOW(),
           updated_at = NOW()
     WHERE id = $1 RETURNING destination_repair_attempts`,
    [id]
  );
  return res.rows[0] || null;
}

async function setRouteAssignmentStatus(id, status) {
  const res = await query(
    `UPDATE route_assignments SET status = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, status]
  );
  return res.rows[0] || null;
}

/**
 * Atomically mark a route completed — used by the auto-completion monitor. The
 * update ONLY fires while status is still 'active', so two overlapping monitor
 * ticks can never both complete the same route (the second UPDATE matches no row
 * and returns null). Records where/when/how far, and stamps completed_at.
 *
 * @param {number} id
 * @param {{ latitude?:number, longitude?:number, distanceMeters?:number, reason?:string }} completionData
 * @returns {Promise<object|null>} the completed row, or null if it was not active
 */
async function completeRouteAssignment(id, {
  latitude = null, longitude = null, distanceMeters = null, reason = null,
} = {}) {
  const res = await query(
    `UPDATE route_assignments
       SET status = 'completed',
           completed_at = NOW(),
           completion_latitude = $2,
           completion_longitude = $3,
           completion_distance_meters = $4,
           completion_reason = $5,
           completion_blocked_reason = NULL,
           last_completion_check_at = NOW(),
           last_destination_distance_meters = COALESCE($4, last_destination_distance_meters),
           updated_at = NOW()
     WHERE id = $1 AND status = 'active'
     RETURNING *`,
    [
      id,
      latitude != null && Number.isFinite(Number(latitude)) ? Number(latitude) : null,
      longitude != null && Number.isFinite(Number(longitude)) ? Number(longitude) : null,
      distanceMeters != null && Number.isFinite(Number(distanceMeters)) ? Number(distanceMeters) : null,
      reason ? String(reason).slice(0, 500) : null,
    ]
  );
  return res.rows[0] || null;
}

module.exports = {
  createRouteAssignment,
  getActiveRouteAssignmentByGroupId,
  findRouteAssignmentByTelegramMessage,
  getRouteAssignment,
  listRouteAssignments,
  setRouteAssignmentGeometry,
  setRouteAssignmentDestinationCoords,
  recordDestinationRepairAttempt,
  setRouteAssignmentStatus,
  completeRouteAssignment,
};
