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
            dp.first_name, dp.last_name, dp.unit_number
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
    `SELECT h.*, g.group_name
     FROM driver_road_history h
     JOIN groups g ON g.id = h.group_id
     ${where}
     ORDER BY h.home_arrived_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
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
};
