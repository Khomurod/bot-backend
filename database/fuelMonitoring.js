/**
 * Fuel Monitor: gas-station proximity alerts + the fuel inbox.
 * Extracted verbatim from database/db.js; db.js re-exports these.
 */
const { query } = require('./pool');

// ─── Fuel Monitor: gas-station proximity alerts ───

// Create one "watching" row for a gas-station location posted in a driver
// group. Skips if an identical un-finished watch already exists for the same
// source message (idempotent against duplicate message handling).
async function createFuelStopAlert({
  groupId,
  telegramGroupId,
  sourceMessageId,
  stationName = null,
  stationAddress = null,
  stationLat,
  stationLng,
  radiusMiles = 10,
  expiresInHours = 24,
}) {
  if (!Number.isFinite(Number(stationLat)) || !Number.isFinite(Number(stationLng))) {
    return null;
  }
  const existing = await query(
    `SELECT id FROM fuel_stop_alerts
     WHERE group_id = $1 AND source_message_id = $2 AND status = 'watching'
     LIMIT 1`,
    [Number(groupId), Number(sourceMessageId)]
  );
  if (existing.rows[0]) return existing.rows[0];

  const res = await query(
    `INSERT INTO fuel_stop_alerts (
       group_id, telegram_group_id, source_message_id,
       station_name, station_address, station_lat, station_lng,
       radius_miles, status, expires_at, next_check_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'watching',
             NOW() + ($9 || ' hours')::INTERVAL, NOW())
     RETURNING *`,
    [
      Number(groupId),
      String(telegramGroupId),
      Number(sourceMessageId),
      stationName ? String(stationName).slice(0, 300) : null,
      stationAddress ? String(stationAddress).slice(0, 500) : null,
      Number(stationLat),
      Number(stationLng),
      Number.isFinite(Number(radiusMiles)) ? Number(radiusMiles) : 10,
      String(Math.max(1, Number(expiresInHours) || 24)),
    ]
  );
  return res.rows[0] || null;
}

// Columns added to every claimed/returned alert row so the service can resolve
// the truck (group title holds the unit #) and tag the driver.
const FUEL_ALERT_JOIN_COLUMNS = `
  (SELECT group_name FROM groups g WHERE g.id = f.group_id) AS group_name,
  (SELECT telegram_username FROM driver_profiles dp WHERE dp.group_id = f.group_id) AS telegram_username,
  (SELECT telegram_user_id FROM driver_profiles dp WHERE dp.group_id = f.group_id) AS telegram_user_id,
  (SELECT first_name FROM driver_profiles dp WHERE dp.group_id = f.group_id) AS first_name,
  (SELECT last_name FROM driver_profiles dp WHERE dp.group_id = f.group_id) AS last_name`;

// Claim watch rows that are DUE (next_check_at reached). Most ticks claim
// nothing because rows schedule their own next check far in the future.
async function claimDueFuelStopAlerts(limit = 20) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 20;
  const res = await query(
    `WITH due AS (
       SELECT id
       FROM fuel_stop_alerts
       WHERE status = 'watching'
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (next_check_at IS NULL OR next_check_at <= NOW())
         AND (processing = FALSE OR processing_started_at < NOW() - INTERVAL '10 minutes')
       ORDER BY next_check_at ASC NULLS FIRST
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE fuel_stop_alerts f
     SET processing = TRUE,
         processing_started_at = NOW()
     FROM due
     WHERE f.id = due.id
     RETURNING f.*, ${FUEL_ALERT_JOIN_COLUMNS}`,
    [safeLimit]
  );
  return res.rows;
}

// Claim a single row by id (for the immediate first-evaluation kickoff right
// after a fuel message is detected). Returns null if already being processed.
async function claimFuelStopAlertById(id) {
  const res = await query(
    `UPDATE fuel_stop_alerts f
     SET processing = TRUE,
         processing_started_at = NOW()
     WHERE f.id = $1
       AND f.status = 'watching'
       AND (f.processing = FALSE OR f.processing_started_at < NOW() - INTERVAL '10 minutes')
     RETURNING f.*, ${FUEL_ALERT_JOIN_COLUMNS}`,
    [Number(id)]
  );
  return res.rows[0] || null;
}

// Release a claimed row back to 'watching' with an updated ETA + next check
// time (the truck has not yet reached the radius).
async function rescheduleFuelStopAlert(id, {
  distanceMiles = null,
  etaMinutes = null,
  etaBoundaryAt = null,
  nextCheckAt,
  error = null,
} = {}) {
  const res = await query(
    `UPDATE fuel_stop_alerts
     SET processing = FALSE,
         processing_started_at = NULL,
         status = 'watching',
         last_distance_miles = COALESCE($2, last_distance_miles),
         last_checked_at = NOW(),
         eta_minutes = $3,
         eta_boundary_at = $4,
         next_check_at = $5,
         last_error = $6
     WHERE id = $1
     RETURNING *`,
    [
      Number(id),
      distanceMiles == null ? null : Number(distanceMiles),
      etaMinutes == null ? null : Number(etaMinutes),
      etaBoundaryAt || null,
      nextCheckAt || null,
      error ? String(error).slice(0, 1000) : null,
    ]
  );
  return res.rows[0] || null;
}

// Latest still-watching alert for a group (for the admin column + manual send),
// with the driver tag fields joined in.
async function getActiveFuelStopAlertForGroup(groupId) {
  const res = await query(
    `SELECT f.*, ${FUEL_ALERT_JOIN_COLUMNS}
     FROM fuel_stop_alerts f
     WHERE f.group_id = $1 AND f.status = 'watching'
     ORDER BY f.created_at DESC
     LIMIT 1`,
    [Number(groupId)]
  );
  return res.rows[0] || null;
}

// Finish a claimed row: 'notified' (fired once), 'watching' (still waiting),
// 'expired', or 'error'.
async function completeFuelStopAlert(id, { status, distanceMiles = null, error = null } = {}) {
  const nextStatus = ['notified', 'watching', 'expired', 'error'].includes(status)
    ? status
    : 'watching';
  const res = await query(
    `UPDATE fuel_stop_alerts
     SET processing = FALSE,
         processing_started_at = NULL,
         status = $2,
         last_distance_miles = COALESCE($3, last_distance_miles),
         last_checked_at = NOW(),
         last_error = $4,
         notified_at = CASE WHEN $2 = 'notified' THEN NOW() ELSE notified_at END
     WHERE id = $1
     RETURNING *`,
    [
      Number(id),
      nextStatus,
      distanceMiles == null ? null : Number(distanceMiles),
      error ? String(error).slice(0, 1000) : null,
    ]
  );
  return res.rows[0] || null;
}

// Mark watch rows past their expiry as expired (housekeeping; keeps the
// working set small).
async function expireOldFuelStopAlerts() {
  const res = await query(
    `UPDATE fuel_stop_alerts
     SET status = 'expired', processing = FALSE, processing_started_at = NULL
     WHERE status = 'watching' AND expires_at IS NOT NULL AND expires_at <= NOW()
     RETURNING id`
  );
  return res.rowCount || 0;
}

// Currently-watching alerts, newest first — powers the admin "watching" view.
async function listActiveFuelStopAlerts() {
  const res = await query(
    `SELECT f.*, g.group_name
     FROM fuel_stop_alerts f
     JOIN groups g ON g.id = f.group_id
     WHERE f.status = 'watching'
     ORDER BY f.created_at DESC`
  );
  return res.rows;
}

// ─── Fuel Monitor inbox ────────────────────────────────────────────────────

// Record a fuel-header message so Refresh can retry it if detection fails.
// ON CONFLICT DO NOTHING — duplicate live deliveries are silently ignored.
async function recordFuelInboxMessage({ groupId, telegramGroupId, messageId, messageText }) {
  const res = await query(
    `INSERT INTO fuel_monitor_inbox (group_id, telegram_group_id, message_id, message_text)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (group_id, message_id) DO NOTHING
     RETURNING *`,
    [
      Number(groupId),
      String(telegramGroupId),
      Number(messageId),
      String(messageText || '').slice(0, 4000),
    ]
  );
  return res.rows[0] || null;
}

// Pending inbox rows created in the last `hours` hours, oldest first (so
// Refresh processes messages in the order the team sent them).
async function listPendingFuelInbox(hours = 24, limit = 50) {
  const safeHours = Math.max(1, Number(hours) || 24);
  const safeLimit = Math.max(1, Number(limit) || 50);
  const res = await query(
    `SELECT i.*, g.group_name
     FROM fuel_monitor_inbox i
     JOIN groups g ON g.id = i.group_id
     WHERE i.status = 'pending'
       AND i.created_at >= NOW() - ($1 || ' hours')::INTERVAL
     ORDER BY i.created_at ASC
     LIMIT $2`,
    [String(safeHours), safeLimit]
  );
  return res.rows;
}

// Mark an inbox row as picked_up (detection + alert creation succeeded).
async function markFuelInboxPickedUp(id, alertId = null) {
  const res = await query(
    `UPDATE fuel_monitor_inbox
     SET status = 'picked_up', alert_id = $2, processed_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [Number(id), alertId ? Number(alertId) : null]
  );
  return res.rows[0] || null;
}

// Remove inbox rows older than `days` days (called during housekeeping tick).
async function deleteOldFuelInbox(days = 3) {
  const res = await query(
    `DELETE FROM fuel_monitor_inbox
     WHERE created_at < NOW() - ($1 || ' days')::INTERVAL`,
    [String(Math.max(1, Number(days) || 3))]
  );
  return res.rowCount || 0;
}


module.exports = {
  createFuelStopAlert,
  claimDueFuelStopAlerts,
  claimFuelStopAlertById,
  rescheduleFuelStopAlert,
  getActiveFuelStopAlertForGroup,
  completeFuelStopAlert,
  expireOldFuelStopAlerts,
  listActiveFuelStopAlerts,
  recordFuelInboxMessage,
  listPendingFuelInbox,
  markFuelInboxPickedUp,
  deleteOldFuelInbox,
};
