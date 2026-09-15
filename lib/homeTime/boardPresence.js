'use strict';

/**
 * Does the Dispatcher Board say this driver is home, or back at work? PURE.
 *
 * WHY THIS IS SEPARATE FROM `returnEvidence.js`. That file answers "did the
 * truck actually leave", from GPS and loads, and it is deliberately hard to
 * satisfy. This one reads a statement a dispatcher typed. They are different
 * kinds of evidence — one observed, one asserted — and a dispatcher saying HOME
 * is the most direct statement anybody makes about where a driver is. Mixing
 * the two into one score would let a missing GPS ping argue with a person who
 * knows the answer.
 *
 * A HOME TIME REQUEST IS NOT EVIDENCE OF ANYTHING HERE, and that is the whole
 * reason this file exists. A driver asking to go home in a chat is a plan; the
 * Board saying HOME is a dispatcher recording that it happened.
 *
 * THREE RULES AGAINST FLAPPING, because two integrations updating at different
 * speeds is the failure this has to survive:
 *
 *   SETTLE.  The Board must have said the same word for `confirmMinutes`
 *            before Wenze acts on it. Dispatch types READY while planning the
 *            week and HOME an hour later; acting on the first sight of either
 *            is how one driver becomes three state changes in an afternoon.
 *
 *   DWELL.   Wenze does not change a state it changed within `dwellMinutes`.
 *            A state that has only just been set is the one most likely to be
 *            about to be argued with.
 *
 *   HOLD.    Fresh, trusted evidence pointing the other way — the driver's own
 *            message, minutes ago — is a reason to wait, NOT to overrule and
 *            NOT to announce. A board a few minutes behind a driver's "I'm
 *            rolling" is normal, and a Needs Attention item about it is noise.
 *            It only becomes a question for a person once the two have
 *            disagreed for `reviewAfterHours` — by then it is not lag.
 *
 * `neutral` IS NOT AN ANSWER. READY, REST, RESERVED and SHOP say nothing about
 * whether somebody is at home, so they produce no action in either direction —
 * see lib/board/statusSemantics.js for why that mapping is conservative.
 */

const { boardSaysHome, boardEndsHomeStay, describeBoardStatus } = require('../board/statusSemantics');

const ACTION = Object.freeze({
  OPEN_HOME: 'open_home',
  CLOSE_HOME: 'close_home',
  HOLD: 'hold',
  REVIEW: 'review',
  NONE: 'none',
});

const DEFAULTS = Object.freeze({
  /** How long the Board must have held a status before it is worth acting on. */
  confirmMinutes: 20,
  /** How recently the snapshot was read for it to describe now. */
  freshMinutes: 90,
  /** How long a state Wenze just set is left alone. */
  dwellMinutes: 30,
  /** How recently the driver themselves said something for it to outrank the Board. */
  driverRecentMinutes: 120,
  /** How long a genuine disagreement runs before a person is asked about it. */
  reviewAfterHours: 12,
});

function minutesSince(iso, nowMs) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (nowMs - t) / 60000;
}

function none(reason, extra = {}) {
  return { action: ACTION.NONE, reason, ...extra };
}

/**
 * @param {object} input
 * @param {string} input.boardStatus        the Board's word, verbatim
 * @param {string} input.statusChangedAt    when the Board last changed that word
 * @param {string} input.lastSeenAt         when Wenze last read this row
 * @param {string} input.wenzeState         'home' | 'road' | null
 * @param {string} input.wenzeStateSince    when Wenze last set that state
 * @param {string} input.driverSaidAt       when the driver themselves last said
 *   something about their state (null when they have not)
 * @param {string} input.driverSaidState    what they said — 'home' | 'road' | null
 * @returns `{ action, reason, eventAt, evidence }`
 */
function decideBoardPresence({
  nowIso = new Date().toISOString(),
  boardStatus = null,
  statusChangedAt = null,
  lastSeenAt = null,
  wenzeState = null,
  wenzeStateSince = null,
  driverSaidAt = null,
  driverSaidState = null,
  options = {},
} = {}) {
  const opts = { ...DEFAULTS, ...options };
  const nowMs = Date.parse(nowIso);
  const says = describeBoardStatus(boardStatus);
  const evidence = {
    boardStatus: boardStatus || null,
    boardSays: says,
    statusHeldMinutes: null,
    snapshotAgeMinutes: null,
  };

  // ASYMMETRIC ON PURPOSE. Opening a home stay needs the board to SAY home;
  // closing one needs only that the truck is back in the dispatch pool, which
  // includes READY. A driver Wenze does not already have at home is never
  // pushed onto the road by this — the agreement check below sees `road` and
  // stops — so the wider list can only ever end a stay, never start one.
  const endsStay = wenzeState === 'home' && boardEndsHomeStay(boardStatus);
  if (!boardSaysHome(boardStatus) && !endsStay) {
    // Includes `neutral`, which is an answer to a different question.
    return none(`the board says ${says === 'unknown' ? 'nothing Wenze understands' : says}`, { evidence });
  }

  const snapshotAge = minutesSince(lastSeenAt, nowMs);
  evidence.snapshotAgeMinutes = snapshotAge == null ? null : Math.round(snapshotAge);
  if (snapshotAge == null || snapshotAge > opts.freshMinutes) {
    // NOT a problem worth telling anybody: the poller's own health already
    // reports a board nobody can read.
    return none('the board snapshot is too old to describe right now', { evidence });
  }

  const held = minutesSince(statusChangedAt, nowMs);
  evidence.statusHeldMinutes = held == null ? null : Math.round(held);
  if (held == null || held < opts.confirmMinutes) {
    return none('the board has only just said this — waiting for it to settle', { evidence });
  }

  const boardState = boardSaysHome(boardStatus) ? 'home' : 'road';
  evidence.endsHomeStay = endsStay;
  evidence.boardState = boardState;

  if (wenzeState === boardState) {
    // Repeated agreement is the common case and must stay free: no write, no
    // finding, no message.
    return none('the board agrees with what Wenze already has', { evidence, agrees: true });
  }

  // HOW LONG THE TWO HAVE DISAGREED. Neither timestamp alone answers it: the
  // board has said its word since `statusChangedAt` and Wenze has held its own
  // since `wenzeStateSince`, so the disagreement is only as old as the later of
  // them. This is what turns a hold that never resolves into a question, rather
  // than a driver held quietly for ever.
  const disagreeingSince = [statusChangedAt, wenzeStateSince]
    .map((iso) => Date.parse(iso))
    .filter((t) => Number.isFinite(t));
  const disagreedHours = disagreeingSince.length
    ? (nowMs - Math.max(...disagreeingSince)) / 3600000
    : null;
  evidence.disagreedHours = disagreedHours == null ? null : Math.round(disagreedHours);

  const holdOrReview = (reason) => {
    if (disagreedHours != null && disagreedHours >= opts.reviewAfterHours) {
      return {
        action: ACTION.REVIEW,
        reason: `${reason}, and the two have disagreed for ${Math.round(disagreedHours)}h`,
        eventAt: null,
        evidence,
      };
    }
    return { action: ACTION.HOLD, reason, eventAt: null, evidence };
  };

  // The driver's own word is the other trusted source, and it is fresher than a
  // spreadsheet by construction.
  const saidAgo = driverSaidAt ? minutesSince(driverSaidAt, nowMs) : null;
  const driverDisagrees = driverSaidState && driverSaidState !== boardState
    && saidAgo != null && saidAgo <= opts.driverRecentMinutes;
  if (driverDisagrees) {
    evidence.driverSaidState = driverSaidState;
    evidence.driverSaidMinutesAgo = Math.round(saidAgo);
    return holdOrReview(`the driver said ${driverSaidState} recently - giving the board time to catch up`);
  }

  const dwell = wenzeStateSince ? minutesSince(wenzeStateSince, nowMs) : null;
  if (wenzeState && dwell != null && dwell < opts.dwellMinutes) {
    evidence.wenzeStateMinutes = Math.round(dwell);
    return holdOrReview('Wenze changed this state moments ago - not changing it back yet');
  }

  // A BOARD STATUS OLDER THAN THE STATE IT WOULD REPLACE IS NOT NEW EVIDENCE.
  //
  // Concretely: the driver writes "Status: Road" at noon, the board has said
  // HOME since eight that morning, and two hours later the hold expires. The
  // board cell has not moved since BEFORE the driver spoke, so it cannot be
  // describing something that happened after — it is a cell nobody has
  // updated. Acting on it would open a home cycle timed earlier than the road
  // leg it closes, and `applyStateTransition` measures the road leg from
  // `state_since` to this timestamp: an inverted pair means zero days out and
  // a bonus computed over negative time.
  //
  // So it is refused rather than clamped. Clamping to `wenzeStateSince` would
  // record a road leg of length zero, which is a fabricated fact rather than a
  // missing one — and the disagreement still reaches a person on its own, by
  // the twelve-hour rule below, because `disagreedHours` counts from whichever
  // of the two is later.
  const stateStartedMs = Date.parse(wenzeStateSince);
  const boardStartedMs = Date.parse(statusChangedAt);
  if (Number.isFinite(stateStartedMs) && Number.isFinite(boardStartedMs)
    && boardStartedMs < stateStartedMs) {
    evidence.boardPredatesState = true;
    return holdOrReview('the board has not moved since before Wenze\u2019s current state began');
  }

  // The event happened when the Board said so, not when Wenze got round to
  // reading it — otherwise a driver who went home on Friday has a cycle that
  // starts on Monday and a road clock that is three days short.
  return {
    action: boardState === 'home' ? ACTION.OPEN_HOME : ACTION.CLOSE_HOME,
    reason: `the board has said ${boardStatus} for ${Math.round(held)} minutes`,
    eventAt: statusChangedAt,
    evidence,
  };
}

/** One short phrase for the transition record and for a manager to read. */
function describeBoardPresence(decision) {
  const e = decision?.evidence || {};
  const parts = [`dispatcher board: ${e.boardStatus || 'unknown'}`];
  if (e.statusHeldMinutes != null) parts.push(`held ${e.statusHeldMinutes} min`);
  if (e.driverSaidState) parts.push(`driver said ${e.driverSaidState} ${e.driverSaidMinutesAgo} min ago`);
  return parts.join(', ');
}

module.exports = { ACTION, DEFAULTS, decideBoardPresence, describeBoardPresence };
