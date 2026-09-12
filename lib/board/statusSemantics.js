/**
 * What a Dispatcher Board status MEANS to Wenze. PURE.
 *
 * The Board's vocabulary is a dispatcher's, not Wenze's: eight words describing
 * where a truck is in today's work. Wenze's own model is narrower — a driver is
 * at home or on the road — so something has to translate, and that translation
 * is a business decision rather than a technical one.
 *
 * THE DEFAULTS ARE THE OWNER'S TO CONFIRM, and this file is the one place to
 * change them. They are deliberately conservative, because these words feed
 * CONTRADICTIONS — a wrong mapping does not produce a wrong correction, it
 * produces a false accusation that two systems disagree, which costs somebody's
 * afternoon.
 *
 *   home     HOME, VACATION          the driver is not working
 *   working  DISPATCHED, ENROUTE     the driver is on the road right now
 *   neutral  READY, RESERVED,        the truck is somewhere in between, and
 *            REST, SHOP              NEITHER of the above may be concluded
 *
 * `neutral` IS THE IMPORTANT ONE. A driver at REST is not at home and not
 * driving; a truck in SHOP says nothing at all about where its driver is. The
 * temptation is to fold those into "working" because they are not HOME — and
 * that is exactly how a driver legitimately resting gets reported as
 * contradicting a home-time record.
 *
 * AN UNKNOWN STATUS IS NEVER A CONCLUSION. A word dispatch invents tomorrow
 * answers false to both questions rather than defaulting to either.
 */

const HOME_STATUSES = Object.freeze(['HOME', 'VACATION']);
const WORKING_STATUSES = Object.freeze(['DISPATCHED', 'ENROUTE']);
const NEUTRAL_STATUSES = Object.freeze(['READY', 'RESERVED', 'REST', 'SHOP']);

function normalise(status) {
  return String(status == null ? '' : status).trim().toUpperCase();
}

/** The board says this driver is not working. */
function boardSaysHome(status) {
  return HOME_STATUSES.includes(normalise(status));
}

/** The board says this driver is on the road right now. */
function boardSaysWorking(status) {
  return WORKING_STATUSES.includes(normalise(status));
}

/**
 * Does the board say anything Wenze can use at all?
 *
 * A caller that needs to distinguish "the board disagrees" from "the board has
 * no opinion" asks this rather than inferring it from two falses — those are
 * the same answer to two different questions.
 */
function boardHasOpinion(status) {
  const s = normalise(status);
  return HOME_STATUSES.includes(s) || WORKING_STATUSES.includes(s);
}

/** `home` | `working` | `neutral` | `unknown` — for evidence, not for logic. */
function describeBoardStatus(status) {
  const s = normalise(status);
  if (HOME_STATUSES.includes(s)) return 'home';
  if (WORKING_STATUSES.includes(s)) return 'working';
  if (NEUTRAL_STATUSES.includes(s)) return 'neutral';
  return 'unknown';
}

module.exports = {
  HOME_STATUSES,
  WORKING_STATUSES,
  NEUTRAL_STATUSES,
  boardSaysHome,
  boardSaysWorking,
  boardHasOpinion,
  describeBoardStatus,
};
