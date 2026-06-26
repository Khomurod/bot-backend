/**
 * Driver Home-Time Tracking — database helpers.
 *
 * Backs the home/road tracker: a single settings row, the current state of each
 * driver group, and a history of completed road trips with their bonus.
 */
const { query } = require('./db');

// ─── Settings (single row, id = 1) ───

async function getHomeTimeSettings() {
  const res = await query('SELECT * FROM home_time_settings WHERE id = 1');
  return res.rows[0] || null;
}

const SETTINGS_COLUMNS = [
  'enabled', 'road_allowance_weeks', 'home_allowance_days', 'bonus_per_week',
];

async function updateHomeTimeSettings(patch = {}) {
  const sets = [];
  const values = [];
  let i = 1;
  for (const col of SETTINGS_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(patch, col)) {
      sets.push(`${col} = $${i}`);
      values.push(patch[col]);
      i += 1;
    }
  }
  if (!sets.length) return getHomeTimeSettings();
  sets.push('updated_at = NOW()');
  const res = await query(
    `UPDATE home_time_settings SET ${sets.join(', ')} WHERE id = 1 RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

// ─── Per-group current state ───

async function getDriverHomeStatus(groupId) {
  const res = await query('SELECT * FROM driver_home_status WHERE group_id = $1', [groupId]);
  return res.rows[0] || null;
}

/** Insert or update the current state for a driver group. */
async function upsertDriverHomeStatus({
  groupId, telegramGroupId, state, stateSince, lastStatusText, lastStatusAt,
}) {
  const res = await query(
    `INSERT INTO driver_home_status
       (group_id, telegram_group_id, state, state_since, last_status_text, last_status_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (group_id) DO UPDATE SET
       telegram_group_id = EXCLUDED.telegram_group_id,
       state = EXCLUDED.state,
       state_since = EXCLUDED.state_since,
       last_status_text = EXCLUDED.last_status_text,
       last_status_at = EXCLUDED.last_status_at,
       updated_at = NOW()
     RETURNING *`,
    [groupId, telegramGroupId != null ? String(telegramGroupId) : null, state, stateSince, lastStatusText || null, lastStatusAt]
  );
  return res.rows[0];
}

/** Touch only the "last seen status" fields without changing the state. */
async function touchDriverHomeStatus({ groupId, lastStatusText, lastStatusAt }) {
  const res = await query(
    `UPDATE driver_home_status
     SET last_status_text = $2, last_status_at = $3, updated_at = NOW()
     WHERE group_id = $1 RETURNING *`,
    [groupId, lastStatusText || null, lastStatusAt]
  );
  return res.rows[0] || null;
}

// ─── Completed road trips (history) ───

async function insertRoadHistory({
  groupId, driverName, unitNumber, roadStartedAt, homeArrivedAt,
  daysOnRoad, exceededWeeks, bonusUsd,
}) {
  const res = await query(
    `INSERT INTO driver_road_history
       (group_id, driver_name, unit_number, road_started_at, home_arrived_at,
        days_on_road, exceeded_weeks, bonus_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [groupId, driverName || null, unitNumber || null, roadStartedAt, homeArrivedAt,
      daysOnRoad, exceededWeeks, bonusUsd]
  );
  return res.rows[0];
}

/** Current state of every tracked driver group, with the group/driver labels. */
async function listCurrentStatuses() {
  const res = await query(
    `SELECT s.*, g.group_name, g.active AS group_active,
            dp.first_name, dp.last_name, dp.unit_number, dp.status AS driver_status, dp.driver_type
     FROM driver_home_status s
     JOIN groups g ON g.id = s.group_id
     LEFT JOIN driver_profiles dp ON dp.group_id = s.group_id
     ORDER BY s.state_since ASC`
  );
  return res.rows;
}

/** Recent completed road trips (most recent first). */
async function listRoadHistory({ limit = 100, bonusOnly = false } = {}) {
  const where = bonusOnly ? 'WHERE bonus_usd > 0' : '';
  const res = await query(
    `SELECT h.*, g.group_name, dp.driver_type
     FROM driver_road_history h
     JOIN groups g ON g.id = h.group_id
     LEFT JOIN driver_profiles dp ON dp.group_id = h.group_id
     ${where}
     ORDER BY h.home_arrived_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

async function getRoadHistoryById(id) {
  const res = await query(
    `SELECT h.*, g.group_name, dp.driver_type
     FROM driver_road_history h
     JOIN groups g ON g.id = h.group_id
     LEFT JOIN driver_profiles dp ON dp.group_id = h.group_id
     WHERE h.id = $1`,
    [id]
  );
  return res.rows[0] || null;
}

/** Admin edit of a completed trip's dates + recomputed bonus fields. */
async function updateRoadHistory(id, {
  roadStartedAt, homeArrivedAt, daysOnRoad, exceededWeeks, bonusUsd,
}) {
  const res = await query(
    `UPDATE driver_road_history
       SET road_started_at = $2, home_arrived_at = $3,
           days_on_road = $4, exceeded_weeks = $5, bonus_usd = $6
     WHERE id = $1 RETURNING *`,
    [id, roadStartedAt, homeArrivedAt, daysOnRoad, exceededWeeks, bonusUsd]
  );
  return res.rows[0] || null;
}

async function deleteRoadHistory(id) {
  const res = await query('DELETE FROM driver_road_history WHERE id = $1 RETURNING id', [id]);
  return res.rows.length > 0;
}

/** Admin edit of the current state's start date (keeps state, moves the clock). */
async function setDriverHomeStateSince(groupId, stateSince) {
  const res = await query(
    `UPDATE driver_home_status
       SET state_since = $2, updated_at = NOW()
     WHERE group_id = $1 RETURNING *`,
    [groupId, stateSince]
  );
  return res.rows[0] || null;
}

// ─── Home-time requests ───

async function insertHomeTimeRequest({
  groupId, telegramGroupId, driverName, unitNumber,
  requestedByUserId, requestedByUsername, roadStartedAt, daysOnRoad,
  policyMet, homeFrom, homeTo, status = 'pending', source = 'telegram',
  aiReasoning, telegramChatId, telegramMessageId,
}) {
  const res = await query(
    `INSERT INTO home_time_requests
       (group_id, telegram_group_id, driver_name, unit_number,
        requested_by_user_id, requested_by_username, road_started_at, days_on_road,
        policy_met, home_from, home_to, status, source, ai_reasoning,
        telegram_chat_id, telegram_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      groupId || null, telegramGroupId != null ? String(telegramGroupId) : null,
      driverName || null, unitNumber || null,
      requestedByUserId || null, requestedByUsername || null,
      roadStartedAt || null, daysOnRoad == null ? null : daysOnRoad,
      policyMet == null ? null : policyMet, homeFrom || null, homeTo || null,
      status, source, aiReasoning || null,
      telegramChatId != null ? String(telegramChatId) : null,
      telegramMessageId == null ? null : telegramMessageId,
    ]
  );
  return res.rows[0];
}

async function getHomeTimeRequestById(id) {
  const res = await query('SELECT * FROM home_time_requests WHERE id = $1', [id]);
  return res.rows[0] || null;
}

/** Most recent still-pending request for a group (to avoid duplicate cards). */
async function getPendingHomeTimeRequestForGroup(groupId) {
  const res = await query(
    `SELECT * FROM home_time_requests
     WHERE group_id = $1 AND status = 'pending'
     ORDER BY requested_at DESC LIMIT 1`,
    [groupId]
  );
  return res.rows[0] || null;
}

/**
 * Decide a request, but only if it is still pending (atomic guard so two
 * approvers tapping at once cannot both win).
 */
async function decideHomeTimeRequest(id, { status, username, userId, homeFrom, homeTo }) {
  const res = await query(
    `UPDATE home_time_requests
       SET status = $2,
           decided_by_username = $3,
           decided_by_user_id = $4,
           decided_at = NOW(),
           home_from = COALESCE($5, home_from),
           home_to = COALESCE($6, home_to)
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id, status, username || null, userId || null, homeFrom || null, homeTo || null]
  );
  return res.rows[0] || null;
}

async function setHomeTimeRequestMessage(id, telegramChatId, telegramMessageId) {
  const res = await query(
    `UPDATE home_time_requests
       SET telegram_chat_id = $2, telegram_message_id = $3
     WHERE id = $1 RETURNING *`,
    [id, telegramChatId != null ? String(telegramChatId) : null,
      telegramMessageId == null ? null : telegramMessageId]
  );
  return res.rows[0] || null;
}

/** Find a request with the exact same home window for a group (dedup on import). */
async function findHomeTimeRequestByWindow(groupId, homeFrom, homeTo) {
  const res = await query(
    `SELECT * FROM home_time_requests
     WHERE group_id = $1 AND home_from = $2 AND home_to = $3
     LIMIT 1`,
    [groupId, homeFrom, homeTo]
  );
  return res.rows[0] || null;
}

async function listHomeTimeRequests({ limit = 200 } = {}) {
  const res = await query(
    `SELECT r.*, g.group_name, dp.driver_type
     FROM home_time_requests r
     LEFT JOIN groups g ON g.id = r.group_id
     LEFT JOIN driver_profiles dp ON dp.group_id = r.group_id
     ORDER BY r.requested_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

// ─── Bot access settings (super admin) ───

async function getBotAccessSettings() {
  const res = await query('SELECT * FROM bot_access_settings WHERE id = 1');
  return res.rows[0] || null;
}

async function updateBotAccessSettings({ superAdminTelegramId, superAdminLabel }) {
  const res = await query(
    `UPDATE bot_access_settings
       SET super_admin_telegram_id = $1,
           super_admin_label = $2,
           updated_at = NOW()
     WHERE id = 1 RETURNING *`,
    [superAdminTelegramId == null ? null : String(superAdminTelegramId), superAdminLabel || null]
  );
  return res.rows[0] || null;
}

module.exports = {
  getHomeTimeSettings,
  updateHomeTimeSettings,
  getDriverHomeStatus,
  upsertDriverHomeStatus,
  touchDriverHomeStatus,
  insertRoadHistory,
  listCurrentStatuses,
  listRoadHistory,
  getRoadHistoryById,
  updateRoadHistory,
  deleteRoadHistory,
  setDriverHomeStateSince,
  insertHomeTimeRequest,
  getHomeTimeRequestById,
  getPendingHomeTimeRequestForGroup,
  decideHomeTimeRequest,
  setHomeTimeRequestMessage,
  findHomeTimeRequestByWindow,
  listHomeTimeRequests,
  getBotAccessSettings,
  updateBotAccessSettings,
};
