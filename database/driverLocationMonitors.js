/**
 * Database helpers for the Driver Location Monitoring feature.
 * Uses the shared pool/query exported from db.js.
 *
 * Two tables back this feature:
 *   - driver_location_monitors   : per-group toggle + scheduler/load state
 *   - driver_location_checkins   : one row per "are you checked in?" prompt,
 *                                  recording the Yes/No answer and on-time flag
 *
 * The claim/poll/reschedule shape mirrors dispatch_eta_updates and
 * fuel_stop_alerts: rows schedule their own next wake-up, and a concurrent-safe
 * `FOR UPDATE SKIP LOCKED` claim lets the poller process due rows without
 * double-sending.
 */
const { query } = require('./db');

function normalizeBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  if (typeof value === 'number') return value === 1;
  return fallback;
}

// Columns joined onto every claimed monitor row so the service can resolve the
// truck (group title holds the unit #) and tag/greet the driver.
const MONITOR_JOIN_COLUMNS = `
  (SELECT group_name FROM groups g WHERE g.id = m.group_id) AS group_name,
  (SELECT telegram_group_id FROM groups g WHERE g.id = m.group_id) AS telegram_group_id,
  (SELECT language FROM groups g WHERE g.id = m.group_id) AS group_language,
  (SELECT telegram_username FROM driver_profiles dp WHERE dp.group_id = m.group_id) AS telegram_username,
  (SELECT telegram_user_id FROM driver_profiles dp WHERE dp.group_id = m.group_id) AS telegram_user_id,
  (SELECT first_name FROM driver_profiles dp WHERE dp.group_id = m.group_id) AS first_name,
  (SELECT last_name FROM driver_profiles dp WHERE dp.group_id = m.group_id) AS last_name`;

/**
 * Driver groups (active) joined with their location-monitor settings. Powers
 * the admin tab list. Mirrors getDriverGroupsWithDispatchEtaSettings().
 */
async function listGroupsWithMonitorSettings() {
  const res = await query(
    `SELECT g.id AS group_id,
            g.group_name,
            g.telegram_group_id,
            g.language,
            g.active,
            (SELECT dp.first_name FROM driver_profiles dp WHERE dp.group_id = g.id) AS first_name,
            (SELECT dp.last_name FROM driver_profiles dp WHERE dp.group_id = g.id) AS last_name,
            (SELECT dp.unit_number FROM driver_profiles dp WHERE dp.group_id = g.id) AS unit_number,
            (SELECT dp.driver_type FROM driver_profiles dp WHERE dp.group_id = g.id) AS driver_type,
            COALESCE(m.enabled, FALSE) AS enabled,
            COALESCE(m.interval_minutes, 30) AS interval_minutes,
            COALESCE(m.checkin_radius_miles, 8) AS checkin_radius_miles,
            m.next_run_at,
            m.last_run_at,
            m.last_status,
            m.last_error,
            m.load_phase,
            m.target_stop_type,
            m.target_address,
            m.target_appointment_at,
            m.last_eta_minutes,
            m.last_eta_at,
            m.last_distance_miles,
            m.current_order_id
     FROM groups g
     LEFT JOIN driver_location_monitors m ON m.group_id = g.id
     WHERE g.group_type = 'driver'
       AND g.active = TRUE
     ORDER BY g.id ASC`
  );
  return res.rows;
}

async function getMonitorByGroupId(groupId) {
  const res = await query(
    `SELECT m.*, ${MONITOR_JOIN_COLUMNS}
     FROM driver_location_monitors m
     WHERE m.group_id = $1
     LIMIT 1`,
    [Number(groupId)]
  );
  return res.rows[0] || null;
}

/**
 * Create/update the per-group monitor row. Enabling schedules an immediate
 * first evaluation (next_run_at = now); disabling clears scheduling.
 */
async function upsertMonitorSetting({
  groupId,
  enabled,
  intervalMinutes = 30,
  checkinRadiusMiles = 8,
  nextRunAt = null,
}) {
  const normalizedEnabled = normalizeBool(enabled, false);
  const safeInterval = Number.isInteger(intervalMinutes) && intervalMinutes >= 1 && intervalMinutes <= 1440
    ? intervalMinutes
    : 30;
  const safeRadius = Number.isFinite(Number(checkinRadiusMiles))
    && Number(checkinRadiusMiles) >= 1
    && Number(checkinRadiusMiles) <= 100
    ? Number(checkinRadiusMiles)
    : 8;
  const res = await query(
    `INSERT INTO driver_location_monitors
       (group_id, enabled, interval_minutes, checkin_radius_miles, next_run_at, processing, processing_started_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, FALSE, NULL, NOW())
     ON CONFLICT (group_id)
     DO UPDATE SET enabled = EXCLUDED.enabled,
                   interval_minutes = EXCLUDED.interval_minutes,
                   checkin_radius_miles = EXCLUDED.checkin_radius_miles,
                   next_run_at = EXCLUDED.next_run_at,
                   processing = FALSE,
                   processing_started_at = NULL,
                   last_error = CASE WHEN EXCLUDED.enabled THEN driver_location_monitors.last_error ELSE NULL END,
                   updated_at = NOW()
     RETURNING *`,
    [Number(groupId), normalizedEnabled, safeInterval, safeRadius, nextRunAt]
  );
  return res.rows[0];
}

/** Claim a single enabled monitor by group id for an immediate evaluation. */
async function claimMonitorByGroupId(groupId) {
  const res = await query(
    `UPDATE driver_location_monitors m
     SET processing = TRUE,
         processing_started_at = NOW(),
         updated_at = NOW()
     WHERE m.group_id = $1
       AND m.enabled = TRUE
       AND (m.processing = FALSE OR m.processing_started_at < NOW() - INTERVAL '10 minutes')
     RETURNING m.*, ${MONITOR_JOIN_COLUMNS}`,
    [Number(groupId)]
  );
  return res.rows[0] || null;
}

/** Claim all monitors whose next_run_at is due (concurrent-safe). */
async function claimDueMonitors(limit = 10) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 10;
  const res = await query(
    `WITH due AS (
       SELECT id
       FROM driver_location_monitors
       WHERE enabled = TRUE
         AND next_run_at IS NOT NULL
         AND next_run_at <= NOW()
         AND (processing = FALSE OR processing_started_at < NOW() - INTERVAL '10 minutes')
       ORDER BY next_run_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE driver_location_monitors m
     SET processing = TRUE,
         processing_started_at = NOW(),
         updated_at = NOW()
     FROM due
     WHERE m.id = due.id
     RETURNING m.*, ${MONITOR_JOIN_COLUMNS}`,
    [safeLimit]
  );
  return res.rows;
}

/**
 * Release a claimed monitor back to the schedule with refreshed state. Pass
 * only the fields you want to change; the rest are preserved.
 */
async function releaseMonitor(id, {
  nextRunAt,
  lastStatus = null,
  lastError = null,
  currentOrderId,
  loadPhase,
  targetStopType,
  targetAddress,
  targetLat,
  targetLng,
  targetAppointmentAt,
  lastEtaMinutes,
  lastEtaAt,
  lastDistanceMiles,
  activeCheckinId,
  cachedContextJson,
} = {}) {
  const res = await query(
    `UPDATE driver_location_monitors
     SET processing = FALSE,
         processing_started_at = NULL,
         last_run_at = NOW(),
         next_run_at = $2,
         last_status = COALESCE($3, last_status),
         last_error = $4,
         current_order_id = COALESCE($5, current_order_id),
         load_phase = COALESCE($6, load_phase),
         target_stop_type = COALESCE($7, target_stop_type),
         target_address = COALESCE($8, target_address),
         target_lat = COALESCE($9, target_lat),
         target_lng = COALESCE($10, target_lng),
         target_appointment_at = COALESCE($11, target_appointment_at),
         last_eta_minutes = COALESCE($12, last_eta_minutes),
         last_eta_at = COALESCE($13, last_eta_at),
         last_distance_miles = COALESCE($14, last_distance_miles),
         active_checkin_id = $15,
         cached_context_json = COALESCE($16, cached_context_json),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      Number(id),
      nextRunAt || null,
      lastStatus,
      lastError ? String(lastError).slice(0, 1000) : null,
      currentOrderId === undefined ? null : currentOrderId,
      loadPhase === undefined ? null : loadPhase,
      targetStopType === undefined ? null : targetStopType,
      targetAddress === undefined ? null : targetAddress,
      Number.isFinite(Number(targetLat)) ? Number(targetLat) : null,
      Number.isFinite(Number(targetLng)) ? Number(targetLng) : null,
      targetAppointmentAt === undefined ? null : targetAppointmentAt,
      Number.isInteger(lastEtaMinutes) ? lastEtaMinutes : null,
      lastEtaAt === undefined ? null : lastEtaAt,
      Number.isFinite(Number(lastDistanceMiles)) ? Number(lastDistanceMiles) : null,
      activeCheckinId === undefined ? null : activeCheckinId,
      cachedContextJson ? JSON.stringify(cachedContextJson) : null,
    ]
  );
  return res.rows[0] || null;
}

/**
 * Clear the cached target stop so the next tick recomputes the phase from
 * scratch (used after a stop is checked in, to advance pickup → delivery).
 */
async function clearMonitorTarget(id, { nextRunAt, lastStatus = null } = {}) {
  const res = await query(
    `UPDATE driver_location_monitors
     SET processing = FALSE,
         processing_started_at = NULL,
         last_run_at = NOW(),
         next_run_at = $2,
         last_status = COALESCE($3, last_status),
         load_phase = NULL,
         target_stop_type = NULL,
         target_address = NULL,
         target_lat = NULL,
         target_lng = NULL,
         target_appointment_at = NULL,
         last_eta_minutes = NULL,
         last_eta_at = NULL,
         last_distance_miles = NULL,
         active_checkin_id = NULL,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [Number(id), nextRunAt || null, lastStatus]
  );
  return res.rows[0] || null;
}

// ─── Check-ins ───

/**
 * Stable one-prompt-per-stop signature. Keyed on the group plus either the
 * order id (Datatruck loads) or the normalized target address (null-order
 * fallback loads), plus the stop type — so a pickup and a delivery each get
 * their own key and are prompted independently, but never twice.
 */
function normalizeAddressForKey(addr) {
  return String(addr || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

function buildStopDedupeKey({ groupId, orderId, stopType, targetAddress }) {
  const g = Number(groupId);
  const st = String(stopType || '');
  const oid = orderId != null ? String(orderId).trim() : '';
  if (oid) return `g${g}:o${oid}:${st}`;
  return `g${g}:a${normalizeAddressForKey(targetAddress)}:${st}`;
}

/**
 * True if a check-in prompt has EVER been created for this stop signature
 * (any status: awaiting/answered/expired). Used to guarantee at-most-once
 * prompting per (group, order|address, stop_type).
 */
async function hasCheckinForStop({ groupId, orderId, stopType, targetAddress }) {
  const key = buildStopDedupeKey({ groupId, orderId, stopType, targetAddress });
  const res = await query(
    `SELECT 1 FROM driver_location_checkins WHERE dedupe_key = $1 LIMIT 1`,
    [key]
  );
  return res.rowCount > 0;
}

/**
 * Insert a check-in prompt row. Stamps the one-prompt-per-stop dedupe_key so
 * the UNIQUE partial index blocks a second prompt for the same stop. On a
 * unique violation (a concurrent claim already inserted), returns
 * { duplicate: true } instead of throwing so the caller can skip sending.
 */
async function createCheckin({
  monitorId,
  groupId,
  telegramGroupId,
  orderId = null,
  stopType,
  locationAddress = null,
  appointmentAt = null,
  etaAt = null,
  distanceMilesAtPrompt = null,
}) {
  const dedupeKey = buildStopDedupeKey({
    groupId,
    orderId,
    stopType,
    targetAddress: locationAddress,
  });
  try {
    const res = await query(
      `INSERT INTO driver_location_checkins
         (monitor_id, group_id, telegram_group_id, order_id, stop_type,
          location_address, appointment_at, eta_at, distance_miles_at_prompt, dedupe_key, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'awaiting_response')
       RETURNING *`,
      [
        Number(monitorId),
        Number(groupId),
        String(telegramGroupId),
        orderId != null ? String(orderId) : null,
        stopType,
        locationAddress ? String(locationAddress).slice(0, 500) : null,
        appointmentAt || null,
        etaAt || null,
        Number.isFinite(Number(distanceMilesAtPrompt)) ? Number(distanceMilesAtPrompt) : null,
        dedupeKey,
      ]
    );
    return res.rows[0] || null;
  } catch (err) {
    if (err && err.code === '23505') {
      return { duplicate: true };
    }
    throw err;
  }
}

async function setCheckinPromptMessageId(id, messageId) {
  const res = await query(
    `UPDATE driver_location_checkins
     SET prompt_message_id = $2
     WHERE id = $1
     RETURNING *`,
    [Number(id), messageId != null ? Number(messageId) : null]
  );
  return res.rows[0] || null;
}

async function getCheckinById(id) {
  const res = await query(
    `SELECT * FROM driver_location_checkins WHERE id = $1 LIMIT 1`,
    [Number(id)]
  );
  return res.rows[0] || null;
}

/**
 * Record the driver's Yes/No answer. Idempotent: only the first answer for a
 * still-awaiting row wins (returns { record, alreadyAnswered }). on_time is
 * computed by the caller (it depends on appointment vs. answer time) and passed
 * in.
 */
async function recordCheckinResponse(id, {
  response,
  username = null,
  userId = null,
  onTime = null,
}) {
  const res = await query(
    `UPDATE driver_location_checkins
     SET status = 'answered',
         driver_response = $2,
         responded_by_username = $3,
         responded_by_user_id = $4,
         responded_at = NOW(),
         on_time = $5
     WHERE id = $1
       AND status = 'awaiting_response'
     RETURNING *`,
    [
      Number(id),
      response,
      username ? String(username).slice(0, 64) : null,
      userId != null ? Number(userId) : null,
      typeof onTime === 'boolean' ? onTime : null,
    ]
  );
  if (res.rows[0]) {
    return { record: res.rows[0], alreadyAnswered: false };
  }
  const current = await getCheckinById(id);
  return { record: current, alreadyAnswered: true };
}

/** Recent check-ins for a group (admin history view). */
async function listCheckinsForGroup(groupId, limit = 50) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50;
  const res = await query(
    `SELECT * FROM driver_location_checkins
     WHERE group_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [Number(groupId), safeLimit]
  );
  return res.rows;
}

/** Per-group on-time summary (counts), used for the admin dashboard cards. */
async function getCheckinStatsForGroup(groupId) {
  const res = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'answered')                          AS answered,
       COUNT(*) FILTER (WHERE driver_response IN ('yes', 'checked_in'))     AS checked_in,
       COUNT(*) FILTER (WHERE driver_response IN ('no', 'checked_out'))     AS checked_out,
       COUNT(*) FILTER (WHERE on_time = TRUE)                               AS on_time,
       COUNT(*) FILTER (WHERE on_time = FALSE)                              AS late
     FROM driver_location_checkins
     WHERE group_id = $1`,
    [Number(groupId)]
  );
  return res.rows[0] || { answered: 0, checked_in: 0, checked_out: 0, on_time: 0, late: 0 };
}

/** Expire stale awaiting prompts so the monitor can re-prompt later if needed. */
async function expireStaleCheckins(olderThanHours = 12) {
  const res = await query(
    `UPDATE driver_location_checkins
     SET status = 'expired'
     WHERE status = 'awaiting_response'
       AND created_at < NOW() - ($1 || ' hours')::INTERVAL
     RETURNING id, monitor_id`,
    [String(Math.max(1, Number(olderThanHours) || 12))]
  );
  return res.rows;
}

module.exports = {
  listGroupsWithMonitorSettings,
  getMonitorByGroupId,
  upsertMonitorSetting,
  claimMonitorByGroupId,
  claimDueMonitors,
  releaseMonitor,
  clearMonitorTarget,
  buildStopDedupeKey,
  hasCheckinForStop,
  createCheckin,
  setCheckinPromptMessageId,
  getCheckinById,
  recordCheckinResponse,
  listCheckinsForGroup,
  getCheckinStatsForGroup,
  expireStaleCheckins,
};
