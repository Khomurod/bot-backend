/**
 * Completed road trips and their bonus — database helpers.
 *
 * The history side of the tracker: a finished road leg is recorded here, home
 * stays are opened and closed against it, and the road-bonus announcement is
 * claimed ATOMICALLY so a restart or an overlapping tick can never announce the
 * same completed leg twice (`driver_road_history.bonus_posted_at`). Split out of
 * database/homeTime.js, which re-exports every symbol here.
 */
const { query } = require('../pool');

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

/**
 * The still-open home stay for a group: the most recent completed road leg whose
 * home stay has not yet been closed (return_to_road_at IS NULL). This is the row
 * a home→road transition closes with the actual home duration.
 */
async function getOpenHomeStay(groupId) {
  const res = await query(
    `SELECT * FROM driver_road_history
     WHERE group_id = $1 AND return_to_road_at IS NULL
     ORDER BY home_arrived_at DESC LIMIT 1`,
    [groupId]
  );
  return res.rows[0] || null;
}

/**
 * Close a home stay: stamp the actual return-to-road time and home duration, and
 * optionally link the decided request that authorized it. Atomic guard on the
 * still-open state so a repeated home→road cannot overwrite a closed stay.
 */
async function closeHomeStay(id, { returnToRoadAt, homeDays, linkedRequestId }) {
  const res = await query(
    `UPDATE driver_road_history
       SET return_to_road_at = $2,
           home_days = $3,
           linked_request_id = COALESCE($4, linked_request_id)
     WHERE id = $1 AND return_to_road_at IS NULL
     RETURNING *`,
    [id, returnToRoadAt, homeDays == null ? null : homeDays,
      linkedRequestId == null ? null : linkedRequestId]
  );
  return res.rows[0] || null;
}

/**
 * Every completed road leg with the driver labels + the status of any linked
 * home-time request, for the efficiency dashboard. `sinceIso` filters on the home
 * arrival (start of the home side of the cycle). The service classifies each row.
 */
async function listCyclesForEfficiency({ sinceIso = null } = {}) {
  const res = await query(
    `SELECT h.id, h.group_id, h.driver_name, h.unit_number,
            h.road_started_at, h.home_arrived_at, h.return_to_road_at,
            h.days_on_road, h.home_days, h.exceeded_weeks, h.bonus_usd,
            h.linked_request_id,
            g.group_name, g.active AS group_active,
            dp.first_name, dp.last_name, dp.unit_number AS profile_unit_number,
            dp.driver_type, dp.status AS driver_status,
            req.status AS linked_request_status,
            req.home_from AS req_home_from, req.return_to_road_date AS req_return_to_road_date, req.home_to AS req_home_to
     FROM driver_road_history h
     JOIN groups g ON g.id = h.group_id
     LEFT JOIN driver_profiles dp ON dp.group_id = h.group_id
     LEFT JOIN home_time_requests req ON req.id = h.linked_request_id
     WHERE ($1::timestamptz IS NULL OR h.home_arrived_at >= $1)
     ORDER BY h.home_arrived_at DESC`,
    [sinceIso]
  );
  return res.rows;
}

/**
 * Completed road legs that earned an extra-week bonus but whose one-time summary
 * has NOT yet been posted to the Extra Week / Road Bonus group. Oldest first so
 * catch-up posts keep chronological order. Backs the idempotent road→home
 * summary flow (services/roadBonusNotifierService.js).
 */
async function listUnpostedRoadBonuses({ limit = 100 } = {}) {
  const res = await query(
    `SELECT h.*, g.group_name, g.telegram_group_id, dp.driver_type
     FROM driver_road_history h
     JOIN groups g ON g.id = h.group_id
     LEFT JOIN driver_profiles dp ON dp.group_id = h.group_id
     WHERE h.bonus_usd > 0 AND h.bonus_posted_at IS NULL
     ORDER BY h.home_arrived_at ASC
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}

/**
 * Atomically claim a completed leg for its bonus summary post: stamps
 * bonus_posted_at only if it was still NULL. Returns the row when THIS caller won
 * the claim, or null if it was already posted/claimed — the idempotency guard
 * that prevents duplicate summaries across restarts, syncs and status updates.
 */
async function claimRoadBonusPost(id) {
  const res = await query(
    `UPDATE driver_road_history
       SET bonus_posted_at = NOW()
     WHERE id = $1 AND bonus_posted_at IS NULL
     RETURNING *`,
    [id]
  );
  return res.rows[0] || null;
}

/** Release a claim (e.g. the Telegram send failed) so a later pass retries it. */
async function unclaimRoadBonusPost(id) {
  const res = await query(
    `UPDATE driver_road_history
       SET bonus_posted_at = NULL
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return res.rows[0] || null;
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

module.exports = {
  insertRoadHistory,
  getOpenHomeStay,
  closeHomeStay,
  listCyclesForEfficiency,
  listUnpostedRoadBonuses,
  claimRoadBonusPost,
  unclaimRoadBonusPost,
  listRoadHistory,
  getRoadHistoryById,
  updateRoadHistory,
  deleteRoadHistory,
};
