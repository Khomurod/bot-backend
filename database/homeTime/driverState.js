/**
 * Driver home/road CURRENT STATE — database helpers.
 *
 * One row per tracked driver group saying whether the driver is home or on the
 * road and since when. The completed-trip history this state produces lives in
 * ./roadHistory.js; the request lifecycle that drives it lives in ./requests.js.
 * Split out of database/homeTime.js, which re-exports every symbol here.
 */
const { query } = require('../pool');

// ─── Per-group current state ───

async function getDriverHomeStatus(groupId) {
  const res = await query('SELECT * FROM driver_home_status WHERE group_id = $1', [groupId]);
  return res.rows[0] || null;
}

/**
 * Insert or update the current state for a driver group.
 *
 * `roadBonusWeeksNotified` resets the extra-week notification watermark. Every
 * real state transition (home→road, road→home, first observation) starts a
 * fresh leg, so callers pass 0 there; the periodic notifier advances it later
 * via setRoadBonusWeeksNotified() without disturbing the state.
 */
async function upsertDriverHomeStatus({
  groupId, telegramGroupId, state, stateSince, lastStatusText, lastStatusAt,
  roadBonusWeeksNotified = 0,
}) {
  const res = await query(
    `INSERT INTO driver_home_status
       (group_id, telegram_group_id, state, state_since, last_status_text, last_status_at, road_bonus_weeks_notified, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (group_id) DO UPDATE SET
       telegram_group_id = EXCLUDED.telegram_group_id,
       state = EXCLUDED.state,
       state_since = EXCLUDED.state_since,
       last_status_text = EXCLUDED.last_status_text,
       last_status_at = EXCLUDED.last_status_at,
       road_bonus_weeks_notified = EXCLUDED.road_bonus_weeks_notified,
       updated_at = NOW()
     RETURNING *`,
    [groupId, telegramGroupId != null ? String(telegramGroupId) : null, state, stateSince,
      lastStatusText || null, lastStatusAt, Math.max(0, Number(roadBonusWeeksNotified) || 0)]
  );
  return res.rows[0];
}

/**
 * Advance (or reset) the extra-week notification watermark for a group without
 * touching its state. Called by the periodic road-bonus notifier after it posts
 * newly-completed weeks, so the same milestone is never posted twice.
 */
async function setRoadBonusWeeksNotified(groupId, weeksNotified) {
  const res = await query(
    `UPDATE driver_home_status
       SET road_bonus_weeks_notified = $2, updated_at = NOW()
     WHERE group_id = $1 RETURNING *`,
    [groupId, Math.max(0, Number(weeksNotified) || 0)]
  );
  return res.rows[0] || null;
}

/**
 * Every driver group currently ON THE ROAD, with the labels + driver type
 * needed to compute and post extra-week bonus milestones. Used by the periodic
 * notifier; owner-operator filtering happens in the service (driver_type can be
 * null here and is then inferred from the group name).
 */
async function listOnRoadStatuses() {
  const res = await query(
    `SELECT s.group_id, s.telegram_group_id, s.state, s.state_since,
            s.road_bonus_weeks_notified,
            g.group_name, g.active AS group_active,
            dp.first_name, dp.last_name, dp.unit_number, dp.driver_type
     FROM driver_home_status s
     JOIN groups g ON g.id = s.group_id
     LEFT JOIN driver_profiles dp ON dp.group_id = s.group_id
     WHERE s.state = 'road'
     ORDER BY s.state_since ASC`
  );
  return res.rows;
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

/**
 * Admin override of the current state ('home' | 'road') and/or its start date.
 * Each field is optional; a null leaves that column untouched (COALESCE). Used by
 * the admin panel so a wrong/auto-detected state can be corrected by hand.
 */
async function setDriverHomeState(groupId, { state, stateSince } = {}) {
  const res = await query(
    `UPDATE driver_home_status
       SET state = COALESCE($2, state),
           state_since = COALESCE($3, state_since),
           updated_at = NOW()
     WHERE group_id = $1 RETURNING *`,
    [groupId, state || null, stateSince || null]
  );
  return res.rows[0] || null;
}

module.exports = {
  getDriverHomeStatus,
  upsertDriverHomeStatus,
  setRoadBonusWeeksNotified,
  listOnRoadStatuses,
  touchDriverHomeStatus,
  listCurrentStatuses,
  setDriverHomeStateSince,
  setDriverHomeState,
};
