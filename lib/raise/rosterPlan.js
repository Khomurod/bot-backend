'use strict';

/**
 * What the dispatch roster SHOULD be, given the Board. PURE — rows in, a plan
 * out. No database, no clock, no Telegram.
 *
 * THE PLAN IS SEPARATE FROM APPLYING IT ON PURPOSE. Sunday's reconciliation
 * rebuilds who every dispatch team is answerable for, minutes before the review
 * link goes out, and getting it wrong means a dispatcher reviews somebody
 * else's drivers for a pay period. That decision deserves to be testable
 * without a database behind it, so everything that DECIDES lives here and
 * everything that WRITES lives in services/raise/boardRoster.js.
 *
 * FOUR OUTCOMES PER DRIVER, and the last two are answers rather than failures:
 *
 *   keep    already on the right team, nothing to do
 *   place   put them on the team the Board's dispatcher names
 *   remove  they are no longer eligible, or the Board no longer carries them
 *   review  the Board names a dispatcher nobody can map to exactly one team,
 *           or names nobody at all — the driver is left where they are NOT,
 *           and a person is told why
 *
 * A HUMAN OVERRIDE OUTRANKS THE BOARD and is never quietly undone. When a
 * person has placed a driver deliberately, this reports the disagreement (so
 * the override is visible and can be retired when the Board catches up) and
 * leaves the row alone. Fighting a human over a spreadsheet cell is how an
 * automatic system earns the right to be switched off.
 */

const { DECISION: MATCH } = require('./dispatcherTeam');

const OUTCOME = Object.freeze({
  KEEP: 'keep',
  PLACE: 'place',
  REMOVE: 'remove',
  REVIEW: 'review',
  OVERRIDE_HELD: 'override_held',
});

/** Why a driver could not be placed — the words a person reads. */
const REVIEW_REASON = Object.freeze({
  NO_DISPATCHER: 'no_dispatcher',
  UNKNOWN_DISPATCHER: 'unknown_dispatcher',
  AMBIGUOUS_DISPATCHER: 'ambiguous_dispatcher',
  NO_BOARD_ROW: 'no_board_row',
  UNRESOLVED_IDENTITY: 'unresolved_identity',
});

function personKeyOf(driver) {
  if (driver.personId != null) return `person:${driver.personId}`;
  if (driver.driverProfileId != null) return `profile:${driver.driverProfileId}`;
  if (driver.groupId != null) return `group:${driver.groupId}`;
  return null;
}

/**
 * Decide the roster.
 *
 * @param {object} input
 * @param {Array} input.eligible   drivers who belong in a raise review at all —
 *   `{ personId, driverProfileId, groupId, unitNumber, driverName,
 *      driverNormalizedName }`
 * @param {Array} input.current    today's active assignments —
 *   `{ id, teamId, personId, driverProfileId, groupId, assignmentSource }`
 * @param {Map}   input.boardByDriver  driver key → `{ rowKey, dispatcher, match }`
 *   where `match` is `matchDispatcherToTeam`'s verdict for that row.
 * @returns `{ actions, summary }`
 */
function planRoster({ eligible = [], current = [], boardByDriver = new Map() } = {}) {
  const actions = [];
  const currentByKey = new Map();
  for (const row of current) {
    const key = personKeyOf(row);
    if (key && !currentByKey.has(key)) currentByKey.set(key, row);
  }
  const seenKeys = new Set();

  for (const driver of eligible) {
    const key = personKeyOf(driver);
    if (!key) {
      // Nothing stable to hold on to. A driver identified only by a name is
      // exactly the case a truck number used to paper over.
      actions.push({
        outcome: OUTCOME.REVIEW, driver, teamId: null,
        reason: REVIEW_REASON.UNRESOLVED_IDENTITY,
      });
      continue;
    }
    seenKeys.add(key);
    const existing = currentByKey.get(key) || null;
    const board = boardByDriver.get(key) || null;

    if (!board) {
      actions.push({
        outcome: OUTCOME.REVIEW, driver, existing, teamId: existing ? existing.teamId : null,
        reason: REVIEW_REASON.NO_BOARD_ROW,
      });
      continue;
    }

    const match = board.match || {};
    if (match.decision !== MATCH.MATCHED) {
      const reason = match.decision === MATCH.AMBIGUOUS
        ? REVIEW_REASON.AMBIGUOUS_DISPATCHER
        : (match.decision === MATCH.EMPTY ? REVIEW_REASON.NO_DISPATCHER : REVIEW_REASON.UNKNOWN_DISPATCHER);
      actions.push({
        outcome: OUTCOME.REVIEW, driver, existing, board,
        teamId: existing ? existing.teamId : null, reason,
      });
      continue;
    }

    // A PERSON'S DECISION IS NOT OVERWRITTEN. It is reported when it disagrees
    // with the Board, and honoured either way.
    if (existing && existing.assignmentSource === 'manual') {
      actions.push({
        outcome: OUTCOME.OVERRIDE_HELD, driver, existing, board,
        teamId: existing.teamId, boardTeamId: match.teamId,
        agrees: Number(existing.teamId) === Number(match.teamId),
      });
      continue;
    }

    if (existing && Number(existing.teamId) === Number(match.teamId)) {
      actions.push({ outcome: OUTCOME.KEEP, driver, existing, board, teamId: match.teamId });
      continue;
    }

    actions.push({
      outcome: OUTCOME.PLACE, driver, existing, board,
      teamId: match.teamId, fromTeamId: existing ? existing.teamId : null,
    });
  }

  // Anyone still on a roster who is no longer eligible. A manual row survives
  // this too: a person put them there, and "the Board stopped carrying them"
  // is not a reason to undo somebody's deliberate decision.
  for (const [key, row] of currentByKey.entries()) {
    if (seenKeys.has(key)) continue;
    if (row.assignmentSource === 'manual') {
      actions.push({ outcome: OUTCOME.OVERRIDE_HELD, existing: row, teamId: row.teamId, agrees: null, stale: true });
      continue;
    }
    actions.push({ outcome: OUTCOME.REMOVE, existing: row, teamId: row.teamId });
  }

  const summary = { keep: 0, place: 0, remove: 0, review: 0, overrideHeld: 0, overrideDisagrees: 0 };
  for (const a of actions) {
    if (a.outcome === OUTCOME.KEEP) summary.keep += 1;
    else if (a.outcome === OUTCOME.PLACE) summary.place += 1;
    else if (a.outcome === OUTCOME.REMOVE) summary.remove += 1;
    else if (a.outcome === OUTCOME.REVIEW) summary.review += 1;
    else if (a.outcome === OUTCOME.OVERRIDE_HELD) {
      summary.overrideHeld += 1;
      if (a.agrees === false) summary.overrideDisagrees += 1;
    }
  }
  return { actions, summary };
}

module.exports = { OUTCOME, REVIEW_REASON, personKeyOf, planRoster };
