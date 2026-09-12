/**
 * Deciding WHO a Dispatcher Board row is about — PURE, no I/O.
 *
 * The Board is the authority on today's assignment; Wenze is the authority on
 * who a person permanently is. Neither can answer the other's question, so
 * something has to join them — and joining them wrongly is the single most
 * expensive mistake available in this application. A Board row attached to the
 * wrong person moves that person's truck, their home-time clock and their
 * bonus.
 *
 * SO THE RULE IS: NOBODY IS MERGED ON A TRUCK NUMBER, AND NOBODY IS MERGED ON A
 * SIMILAR NAME. A link may only ACT when two independent facts agree — the
 * truck (as `(fleet_type, unit_number)`, never a bare number) and the name, and
 * the name strictly rather than fuzzily. One fact alone is a suggestion for a
 * person to approve. Two facts that disagree is a question, never a tie-break.
 *
 * WHY TWO NAME TESTS, which looks like duplication and is not:
 *
 *   `namesAgreeStrictly` may ACT. Exact after normalisation, or every word of
 *   the shorter name present in the longer one with at least two words to go
 *   on. "JOHN SMITH" vs "JOHN A SMITH" passes. A shared surname does not.
 *
 *   `driverNamesMatch` (the repository's existing one) may only SUGGEST. It
 *   returns true on a shared surname and on two shared three-letter tokens —
 *   two brothers match — which is right for generating candidates and wrong
 *   for deciding one.
 *
 * A TEAM IS TWO PEOPLE ON ONE TRUCK. Each member is decided separately and they
 * must land on DIFFERENT people; a team whose two names resolve to one person
 * is a composite row that needs splitting by hand, and this module says so
 * rather than picking one.
 */
const { FLEET_TYPES } = require('../drivers/fleetType');
const { normalizePersonName, driverNamesMatch } = require('../drivers/driverGroupTitle');

/** Both facts agree, on an exact-string truck and a strict name. */
const LINK_CONFIDENCE = 95;
/** One fact, and a person to approve it. */
const SUGGEST_CONFIDENCE = 70;

const CHECKS = Object.freeze({
  CONFLICT: 'board.person_link_conflict',
  AMBIGUOUS: 'board.person_link_ambiguous',
  UNMATCHED: 'board.person_unmatched',
  TEAM_SPLIT: 'board.team_person_needs_split',
});

function tokensOf(name) {
  return normalizePersonName(name).split(/\s+/).filter(Boolean);
}

/**
 * Strict enough to act on.
 *
 * Not `driverNamesMatch`: that one exists to GENERATE candidates and is
 * deliberately generous — a shared surname is a match to it. Acting on a shared
 * surname is how two brothers become one person.
 */
function namesAgreeStrictly(a, b) {
  const left = normalizePersonName(a);
  const right = normalizePersonName(b);
  if (!left || !right) return false;
  if (left === right) return true;

  const shorter = tokensOf(left.length <= right.length ? left : right);
  const longer = tokensOf(left.length <= right.length ? right : left);
  // ONE WORD IS NEVER ENOUGH. "SMITH" inside "JOHN SMITH" is a surname, not an
  // identification, and a middle name or a suffix is the only difference this
  // is meant to forgive.
  if (shorter.length < 2) return false;
  return shorter.every((token) => longer.includes(token));
}

/** Two known, different fleets are two different trucks. `unknown` never wins. */
function sameFleet(a, b) {
  const left = a || FLEET_TYPES.UNKNOWN;
  const right = b || FLEET_TYPES.UNKNOWN;
  if (left === FLEET_TYPES.UNKNOWN || right === FLEET_TYPES.UNKNOWN) return false;
  return left === right;
}

function noLink(checkKey, reason, extra = {}) {
  return { action: 'ask', checkKey, personId: null, confidence: null, reason, ...extra };
}

/**
 * Decide one Board row (or one member of a team row).
 *
 * @param {object} input
 * @param {object} input.row  a `dispatch_board_rows` row: `cleanName`,
 *   `fleetType`, `truckNorm`, `personId`, `isTeam`
 * @param {string} [input.name]  which name to decide — a team row passes each
 *   member in turn; defaults to the row's own clean name
 * @param {Array<{personId:number, displayName:string, fleetType:string, seat:number,
 *   truckExact:boolean}>} [input.unitHolders]  people already recorded in this
 *   truck. `truckExact` says the match was the exact string and not the
 *   digits-only form, which may suggest and never act.
 * @param {Array<{personId:number, displayName:string, fleetType:string}>} [input.nameCandidates]
 *   people whose name matches loosely — candidates, not answers.
 * @returns {{action:'none'|'link'|'suggest'|'ask', personId:number|null,
 *   confidence:number|null, checkKey:string|null, reason:string}}
 */
function decideBoardLink({
  row = {}, name = null, unitHolders = [], nameCandidates = [],
} = {}) {
  const who = name || row.cleanName || '';
  const holders = Array.isArray(unitHolders) ? unitHolders : [];
  const names = Array.isArray(nameCandidates) ? nameCandidates : [];

  if (!normalizePersonName(who)) {
    return {
      action: 'ask', checkKey: CHECKS.UNMATCHED, personId: null, confidence: null,
      reason: 'the board row names nobody',
    };
  }

  // ── already decided ───────────────────────────────────────────────────────
  //
  // A row whose person still agrees with the evidence is finished. Re-deciding
  // it every sweep would turn one settled question into a permanent one, and a
  // person who was linked by hand must not be second-guessed by a rule.
  if (row.personId) {
    const stillFits = holders.some((h) => h.personId === row.personId)
      || names.some((n) => n.personId === row.personId);
    if (stillFits || holders.length === 0) {
      return { action: 'none', personId: row.personId, confidence: null, checkKey: null, reason: 'already linked' };
    }
    return noLink(
      CHECKS.CONFLICT,
      'this row is linked to somebody the truck no longer belongs to',
      { linkedPersonId: row.personId }
    );
  }

  // ── the truck ─────────────────────────────────────────────────────────────
  const sameFleetHolders = holders.filter((h) => sameFleet(row.fleetType, h.fleetType));

  if (sameFleetHolders.length === 1) {
    const [holder] = sameFleetHolders;
    // A DIGITS-ONLY TRUCK MATCH MAY NEVER ACT. `001` and `1` and `001A` reduce
    // to the same digits and are three trucks; the exact string is the only
    // spelling strong enough to justify a write.
    if (holder.truckExact === false) {
      return noLink(CHECKS.AMBIGUOUS, 'the truck only matches once the spelling is ignored');
    }
    if (namesAgreeStrictly(who, holder.displayName)) {
      return {
        action: 'link', personId: holder.personId, confidence: LINK_CONFIDENCE,
        checkKey: null, reason: 'the truck and the name both say this person',
      };
    }
    // THE EXPENSIVE CASE, AND IT IS A QUESTION. The Board says this truck, we
    // say a different person is in it. One of the two is out of date and
    // picking either would be a guess with somebody's bonus attached.
    return noLink(
      CHECKS.CONFLICT,
      'the board and the records disagree about who is in this truck',
      { holderPersonId: holder.personId }
    );
  }

  if (sameFleetHolders.length > 1) {
    return noLink(CHECKS.AMBIGUOUS, 'more than one person is recorded in this truck');
  }

  // Holders exist, but in another fleet — a different truck with the same
  // number. Not evidence about this row at all, so fall through to the name.
  // ── the name alone ────────────────────────────────────────────────────────
  const strict = names.filter((c) => namesAgreeStrictly(who, c.displayName));
  const loose = names.filter((c) => driverNamesMatch(who, c.displayName));

  if (strict.length === 1) {
    return {
      action: 'suggest', personId: strict[0].personId, confidence: SUGGEST_CONFIDENCE,
      checkKey: null, reason: 'the name matches one person, and nobody is recorded in this truck',
    };
  }
  if (strict.length > 1) {
    return noLink(CHECKS.AMBIGUOUS, 'the name matches more than one person');
  }
  if (loose.length >= 1) {
    // A LOOSE MATCH IS NEVER AN ANSWER, however lonely. This is exactly the
    // shared-surname case, and a suggestion carries an implicit "probably"
    // that a shared surname has not earned.
    return noLink(CHECKS.AMBIGUOUS, 'the name is close to somebody, but not close enough to say');
  }

  return {
    action: 'ask', checkKey: CHECKS.UNMATCHED, personId: null, confidence: null,
    reason: 'nobody in Wenze matches this board row',
  };
}

/**
 * Decide a team row: both members, and they must be different people.
 *
 * @returns {{members: Array<object>, conflict: object|null}}
 */
function decideTeamBoardLink({ row = {}, members = [], lookupFor = () => ({}) } = {}) {
  const decided = members.map((member) => ({
    name: member,
    ...decideBoardLink({ row, name: member, ...lookupFor(member) }),
  }));

  // TWO NAMES THAT RESOLVE TO ONE PERSON is a composite row — "A / B" stored as
  // a single person years ago. Splitting it is a judgement about two humans and
  // is never done automatically; the decision here is to link NEITHER and say
  // why, because linking one of them silently picks a winner.
  const acting = decided.filter((d) => d.action === 'link' || d.action === 'suggest');
  const ids = acting.map((d) => d.personId);
  const collided = ids.length > 1 && new Set(ids).size < ids.length;
  if (collided) {
    return {
      members: decided.map((d) => ({
        ...d, action: 'ask', personId: null, confidence: null, checkKey: CHECKS.TEAM_SPLIT,
        reason: 'both team members resolve to one person, which needs splitting by hand',
      })),
      conflict: { checkKey: CHECKS.TEAM_SPLIT, personId: ids[0] },
    };
  }
  return { members: decided, conflict: null };
}

module.exports = {
  CHECKS,
  LINK_CONFIDENCE,
  SUGGEST_CONFIDENCE,
  namesAgreeStrictly,
  sameFleet,
  decideBoardLink,
  decideTeamBoardLink,
};
