/**
 * Route Control — database helpers.
 *
 * Route assignments (a Google Maps directions link tied to a driver group, with
 * the computed geometry + live monitoring state) and a per-assignment audit
 * trail of monitoring checks / notifications.
 */
const { query } = require('./db');

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

/**
 * Store (or replace) the route screenshot for an assignment. One screenshot per
 * assignment: any previous one is deleted in the same transaction-free pass
 * (worst case a failed insert leaves no screenshot, never two).
 */
async function saveRouteScreenshot(assignmentId, { mimeType, data, uploadedBy = null }) {
  if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('screenshot data buffer is required');
  await query(
    `DELETE FROM route_assignment_attachments WHERE assignment_id = $1 AND kind = 'route_screenshot'`,
    [assignmentId]
  );
  const res = await query(
    `INSERT INTO route_assignment_attachments
       (assignment_id, kind, mime_type, file_size_bytes, file_data, uploaded_by)
     VALUES ($1, 'route_screenshot', $2, $3, $4, $5)
     RETURNING id, assignment_id, kind, mime_type, file_size_bytes, uploaded_by, created_at`,
    [assignmentId, String(mimeType || 'image/png'), data.length, data, uploadedBy ? String(uploadedBy).slice(0, 128) : null]
  );
  return res.rows[0];
}

/** Fetch the route screenshot WITH bytes (Telegram send / auth-gated preview only). */
async function getRouteScreenshot(assignmentId) {
  const res = await query(
    `SELECT id, assignment_id, mime_type, file_size_bytes, file_data, uploaded_by, created_at
       FROM route_assignment_attachments
      WHERE assignment_id = $1 AND kind = 'route_screenshot'
      ORDER BY created_at DESC LIMIT 1`,
    [assignmentId]
  );
  return res.rows[0] || null;
}

/** Remove the route screenshot (admin "remove" action). */
async function deleteRouteScreenshot(assignmentId) {
  const res = await query(
    `DELETE FROM route_assignment_attachments
      WHERE assignment_id = $1 AND kind = 'route_screenshot'`,
    [assignmentId]
  );
  return { deleted: res.rowCount > 0 };
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

/** Record a successful "route message sent to driver group" delivery. */
async function recordDriverGroupMessageSent(id, { telegramMessageId = null, sentBy = null } = {}) {
  const res = await query(
    `UPDATE route_assignments
       SET driver_group_message_sent_at = NOW(),
           driver_group_message_id = $2,
           driver_group_message_sent_by = $3,
           updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, telegramMessageId ?? null, sentBy ? String(sentBy).slice(0, 128) : null]
  );
  return res.rows[0] || null;
}

async function insertRouteMonitorEvent({
  assignmentId, eventType, result, latitude, longitude, deviationMeters, detail,
}) {
  const res = await query(
    `INSERT INTO route_monitor_events
       (assignment_id, event_type, result, latitude, longitude, deviation_meters, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      assignmentId, eventType, result || null,
      latitude ?? null, longitude ?? null, deviationMeters ?? null, detail || null,
    ]
  );
  return res.rows[0];
}

async function listRouteMonitorEvents(assignmentId, { limit = 50 } = {}) {
  const res = await query(
    `SELECT * FROM route_monitor_events
     WHERE assignment_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [assignmentId, limit]
  );
  return res.rows;
}

module.exports = {
  createRouteAssignment,
  getRouteAssignment,
  getActiveRouteAssignmentByGroupId,
  findRouteAssignmentByTelegramMessage,
  listRouteAssignments,
  listMonitorableAssignments,
  listPendingTrackingAssignments,
  activateTracking,
  setTrackingHoldReason,
  setRouteAssignmentGeometry,
  updateRouteAssignmentMonitorState,
  setRouteAssignmentStatus,
  completeRouteAssignment,
  recordDriverGroupMessageSent,
  insertRouteMonitorEvent,
  listRouteMonitorEvents,
  saveRouteScreenshot,
  getRouteScreenshot,
  deleteRouteScreenshot,
};
