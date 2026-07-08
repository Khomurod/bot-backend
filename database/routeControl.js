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
}) {
  const res = await query(
    `INSERT INTO route_assignments
       (group_id, driver_profile_id, driver_label, unit_number, original_url,
        origin_text, destination_text, waypoints,
        origin_lat, origin_lng, destination_lat, destination_lng,
        encoded_polyline, distance_meters, duration_seconds, assigned_by,
        source, assigned_by_user_id, telegram_chat_id, telegram_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING *`,
    [
      groupId || null, driverProfileId || null, driverLabel || null, unitNumber || null,
      originalUrl, originText || null, destinationText || null, toJson(waypoints),
      originLat ?? null, originLng ?? null, destinationLat ?? null, destinationLng ?? null,
      encodedPolyline || null, distanceMeters ?? null, durationSeconds ?? null, assignedBy || null,
      source || 'admin', assignedByUserId ?? null, telegramChatId ?? null, telegramMessageId ?? null,
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

async function getRouteAssignment(id) {
  const res = await query(
    `SELECT r.*, g.group_name, g.telegram_group_id, g.active AS group_active
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
    `SELECT r.*, g.group_name, g.telegram_group_id, g.active AS group_active
     FROM route_assignments r
     LEFT JOIN groups g ON g.id = r.group_id
     ${where}
     ORDER BY r.updated_at DESC
     LIMIT $${i}`,
    values
  );
  return res.rows;
}

/** Active assignments that carry route geometry — the ones the monitor checks. */
async function listMonitorableAssignments() {
  const res = await query(
    `SELECT r.*, g.group_name, g.telegram_group_id, g.active AS group_active
     FROM route_assignments r
     JOIN groups g ON g.id = r.group_id
     WHERE r.status = 'active' AND r.encoded_polyline IS NOT NULL
     ORDER BY r.updated_at ASC`
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
  setRouteAssignmentGeometry,
  updateRouteAssignmentMonitorState,
  setRouteAssignmentStatus,
  recordDriverGroupMessageSent,
  insertRouteMonitorEvent,
  listRouteMonitorEvents,
};
