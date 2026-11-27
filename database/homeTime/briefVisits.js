'use strict';

/**
 * Brief visits — the two writes the 12-hour rule makes (lib/homeTime/
 * briefVisits.js), and the read that finds the stay a reopen would continue.
 *
 * Each write is guarded on the state the caller read, so a person, a second
 * path or a bonus decision that moved the row first wins and this writes
 * nothing: the caller then records the transition the ordinary way.
 */

const { query } = require('../pool');
const { CURRENT_PERSON_CTE, THIS_DRIVERS_ROW } = require('./roadHistory');

/** A row whose bonus has not been posted or decided yet (or that carries none). */
const BONUS_STILL_OPEN = `(COALESCE(bonus_usd, 0) <= 0
          OR (bonus_posted_at IS NULL AND COALESCE(bonus_decision, 'waiting_home_stay') = 'waiting_home_stay'))`;

/**
 * Close a home stay too short to be one, and fold it into the road trip it
 * interrupted. Its bonus is zeroed, not decided: the trip goes on, and the
 * next real arrival records it whole, with its whole bonus. The figures it
 * held are kept in `folded_reason`.
 *
 * @returns {Promise<object|null>} the folded row, or null when it was no longer open
 */
async function foldHomeStay(id, {
  returnToRoadAt, reason, closedBy = null, closedEvidence = null,
}) {
  const res = await query(
    `UPDATE driver_road_history
        SET return_to_road_at = $2,
            home_days = 0,
            folded_at = NOW(),
            folded_reason = $3,
            closed_by = COALESCE($4, closed_by),
            closed_evidence = COALESCE($5, closed_evidence),
            exceeded_weeks = 0,
            bonus_usd = 0,
            bonus_decision = NULL,
            bonus_decision_reason = NULL,
            bonus_decided_at = NULL
      WHERE id = $1 AND return_to_road_at IS NULL AND folded_at IS NULL
        AND ${BONUS_STILL_OPEN}
      RETURNING *`,
    [id, returnToRoadAt, reason || null, closedBy || null, closedEvidence || null]
  );
  return res.rows[0] || null;
}

/** This group's driver's newest closed, unfolded home stay — the one a brief road segment would continue. */
async function getLastClosedHomeStay(groupId) {
  const res = await query(
    `WITH ${CURRENT_PERSON_CTE}
     SELECT h.* FROM driver_road_history h
      WHERE h.return_to_road_at IS NOT NULL
        AND h.folded_at IS NULL
        AND ${THIS_DRIVERS_ROW}
      ORDER BY h.home_arrived_at DESC, h.id DESC
      LIMIT 1`,
    [groupId]
  );
  return res.rows[0] || null;
}

/**
 * Reopen a home stay the driver came back to after only a few hours on the
 * road: one stay, its days counted from the first arrival when it closes.
 * Guarded on the return the caller read and on the bonus not being decided.
 *
 * @returns {Promise<object|null>} the reopened row, or null when it moved
 */
async function reopenHomeStay(id, { expectedReturnAt, arrivedAgainAt, note }) {
  const res = await query(
    `UPDATE driver_road_history
        SET return_to_road_at = NULL,
            home_days = NULL,
            closed_by = NULL,
            closed_evidence = NULL,
            reopened_at = $3,
            reopened_note = $4
      -- The return the caller read, to the second: a value read back through
      -- a JS Date has lost its microseconds.
      WHERE id = $1
        AND return_to_road_at BETWEEN $2::timestamptz - INTERVAL '1 second' AND $2::timestamptz + INTERVAL '1 second'
        AND folded_at IS NULL
        AND ${BONUS_STILL_OPEN}
      RETURNING *`,
    [id, expectedReturnAt, arrivedAgainAt, note || null]
  );
  return res.rows[0] || null;
}

module.exports = { foldHomeStay, getLastClosedHomeStay, reopenHomeStay };
