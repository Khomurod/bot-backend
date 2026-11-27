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

/**
 * @param {string|null} [bonusPostedAt]  stamp the leg as already-announced.
 *   Used by the silent paths (an admin correction, a screenshot import): the
 *   notifier polls for `bonus_usd > 0 AND bonus_posted_at IS NULL`, so a leg
 *   recorded without announcement must be born claimed. Doing it here rather
 *   than with a follow-up UPDATE closes the window in which the insert succeeds,
 *   the claim fails, and months-old bonuses land in a live group an hour later.
 */
async function insertRoadHistory({
  groupId, driverName, unitNumber, roadStartedAt, homeArrivedAt,
  daysOnRoad, exceededWeeks, bonusUsd, bonusPostedAt = null,
  openedBy = null, openedEvidence = null, bonusDecision = null,
}) {
  const res = await query(
    // person_id is the group's OPEN association at write time (migration 0026):
    // the leg belongs to whoever is in the chat now, and NULL when the person
    // layer has not met this group yet.
    `INSERT INTO driver_road_history
       (group_id, driver_name, unit_number, road_started_at, home_arrived_at,
        days_on_road, exceeded_weeks, bonus_usd, bonus_posted_at, person_id,
        opened_by, opened_evidence, bonus_decision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             (SELECT person_id FROM driver_person_groups WHERE group_id = $1 AND ended_at IS NULL LIMIT 1),
             $10, $11, $12)
     RETURNING *`,
    [groupId, driverName || null, unitNumber || null, roadStartedAt, homeArrivedAt,
      daysOnRoad, exceededWeeks, bonusUsd, bonusPostedAt,
      openedBy || null, openedEvidence || null, bonusDecision || null]
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
 * Every still-open home stay this group's DRIVER has — on this chat or on any
 * chat the same person held before it — newest first.
 *
 * The group-only lookup above is what left 25 cycles structurally unreachable
 * and, after a truck change, left the old chat's open stay orphaned while the
 * new chat started from nothing. With the person layer (migration 0026) the
 * return observed on the new chat can close the stay that began on the old one.
 * Rows with no person fall back to the group alone, so nothing changes for a
 * driver the layer has not met.
 */
/**
 * The rows that are THIS group's driver's, as a CTE and a predicate on `h`
 * (`$1` = the group). A stay on this chat that names a DIFFERENT person is the
 * previous occupant's — the chat was handed on — and the new driver's return
 * must not close it. The chat-only branch therefore covers unstamped rows (and
 * every row when the chat has no person at all), never another driver's.
 * Shared with database/homeTime/briefVisits.js, which must find the same
 * driver's stays the same way.
 */
const CURRENT_PERSON_CTE = `current_person AS (
       SELECT person_id FROM driver_person_groups WHERE group_id = $1 AND ended_at IS NULL LIMIT 1
     )`;
const THIS_DRIVERS_ROW = `(
          (h.group_id = $1 AND (h.person_id IS NULL
                                OR h.person_id = (SELECT person_id FROM current_person)
                                OR NOT EXISTS (SELECT 1 FROM current_person)))
          OR h.person_id = (SELECT person_id FROM current_person)
        )`;

async function listOpenHomeStays(groupId) {
  const res = await query(
    `WITH ${CURRENT_PERSON_CTE}
     SELECT h.* FROM driver_road_history h
      WHERE h.return_to_road_at IS NULL
        AND ${THIS_DRIVERS_ROW}
      ORDER BY h.home_arrived_at DESC, h.id DESC`,
    [groupId]
  );
  return res.rows;
}

/**
 * Close a home stay: stamp the actual return-to-road time and home duration, and
 * optionally link the decided request that authorized it. Atomic guard on the
 * still-open state so a repeated home→road cannot overwrite a closed stay.
 */
async function closeHomeStay(id, {
  returnToRoadAt, homeDays, linkedRequestId, closedBy = null, closedEvidence = null,
}) {
  const res = await query(
    `UPDATE driver_road_history
       SET return_to_road_at = $2,
           home_days = $3,
           linked_request_id = COALESCE($4, linked_request_id),
           closed_by = COALESCE($5, closed_by),
           closed_evidence = COALESCE($6, closed_evidence)
     WHERE id = $1 AND return_to_road_at IS NULL
     RETURNING *`,
    [id, returnToRoadAt, homeDays == null ? null : homeDays,
      linkedRequestId == null ? null : linkedRequestId,
      closedBy || null, closedEvidence || null]
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
       -- A brief visit folded into its road trip is not a cycle: the trip it
       -- interrupted is recorded whole by the next real arrival.
       AND h.folded_at IS NULL
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
       -- Only a DECIDED leg: released (the summary) or forfeited (one note
       -- saying why there is no bonus). A leg still waiting on the home stay or
       -- held for a person is never posted; a NULL decision is a leg from
       -- before decisions existed, posted or claimed at its transition.
       AND h.bonus_decision IN ('released', 'forfeited')
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
     WHERE id = $1 AND bonus_posted_at IS NULL AND bonus_decision IN ('released', 'forfeited')
     RETURNING *`,
    [id]
  );
  return res.rows[0] || null;
}

/**
 * Legs whose home stay has ended and whose bonus is still waiting on it — the
 * ones the poller can now decide.
 */
async function listRoadBonusesAwaitingDecision({ limit = 100, settleHours = 0 } = {}) {
  // `settleHours`: a stay that closed this recently may still be reopened by a
  // brief road segment (lib/homeTime/briefVisits.js), and its home days with
  // it — so it is not decided until the driver has been gone that long.
  const res = await query(
    `SELECT h.*, g.group_name
       FROM driver_road_history h
       JOIN groups g ON g.id = h.group_id
      WHERE h.bonus_decision = 'waiting_home_stay'
        AND h.bonus_posted_at IS NULL
        AND h.return_to_road_at IS NOT NULL
        AND h.return_to_road_at <= NOW() - make_interval(secs => $2::double precision * 3600)
        AND h.folded_at IS NULL
      ORDER BY h.id ASC
      LIMIT $1`,
    [limit, Math.max(0, Number(settleHours) || 0)]
  );
  return res.rows;
}

/**
 * Move a leg's bonus decision, only from the state the caller read.
 *
 * Guarded on `from`, so two passes deciding the same leg cannot both win, and
 * a person who already approved a held leg is never overwritten by a pass that
 * read it a moment earlier. Returns the row when THIS caller moved it.
 */
async function setRoadBonusDecision(id, { from, to, reason = null }) {
  const res = await query(
    `UPDATE driver_road_history
        SET bonus_decision = $3,
            bonus_decision_reason = $4,
            bonus_decided_at = NOW()
      WHERE id = $1 AND bonus_decision = $2 AND bonus_posted_at IS NULL
      RETURNING *`,
    [id, from, to, reason]
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

/**
 * Recent completed road trips (most recent first).
 *
 * `current_group_id` is the chat the leg's PERSON is on now, when the layer
 * knows them — so a driver who changed truck sees their whole history under the
 * new chat rather than split across two.
 */
async function listRoadHistory({ limit = 100, bonusOnly = false } = {}) {
  // A brief visit folded into its road trip is kept in the table, marked, and
  // left out of the history a manager reads: the trip it interrupted is shown
  // once, whole, by the next real arrival.
  const where = bonusOnly ? 'WHERE h.folded_at IS NULL AND h.bonus_usd > 0' : 'WHERE h.folded_at IS NULL';
  const res = await query(
    `SELECT h.*, g.group_name, dp.driver_type,
            (SELECT pg.group_id FROM driver_person_groups pg
              WHERE pg.person_id = h.person_id AND pg.ended_at IS NULL LIMIT 1) AS current_group_id
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
  // AN EDIT RE-OPENS THE BONUS DECISION. The days and the amount are what the
  // decision was made from, so a leg released at 35 days and corrected to 117
  // must not be paid without the review the longer trip requires — nor a held
  // 117-day leg stay held once its clock is fixed. A leg whose summary already
  // went out is history and keeps its decision.
  const res = await query(
    `UPDATE driver_road_history
       SET road_started_at = $2, home_arrived_at = $3,
           days_on_road = $4, exceeded_weeks = $5, bonus_usd = $6::numeric,
           bonus_decision = CASE WHEN bonus_posted_at IS NULL AND $6::numeric > 0
                                 THEN 'waiting_home_stay' ELSE bonus_decision END,
           bonus_decision_reason = CASE WHEN bonus_posted_at IS NULL AND $6::numeric > 0
                                        THEN NULL ELSE bonus_decision_reason END,
           bonus_decided_at = CASE WHEN bonus_posted_at IS NULL AND $6::numeric > 0
                                   THEN NULL ELSE bonus_decided_at END
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
  CURRENT_PERSON_CTE,
  THIS_DRIVERS_ROW,
  insertRoadHistory,
  getOpenHomeStay,
  listOpenHomeStays,
  closeHomeStay,
  listCyclesForEfficiency,
  listUnpostedRoadBonuses,
  listRoadBonusesAwaitingDecision,
  setRoadBonusDecision,
  claimRoadBonusPost,
  unclaimRoadBonusPost,
  listRoadHistory,
  getRoadHistoryById,
  updateRoadHistory,
  deleteRoadHistory,
};
