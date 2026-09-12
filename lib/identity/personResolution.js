/**
 * Deciding who is behind a driver group — PURE, no I/O.
 *
 * The identity layer (migration 0015) records people; this module decides, from
 * evidence the caller has already loaded, what to record. Keeping the decision
 * pure means the three situations that matter can be tested as plain values:
 *
 *   A NEW CHAT for a driver we already know. The old chat went inactive when the
 *   truck changed; a new one appeared with the same name. That is the SAME
 *   person on a new group — the association moves, and nothing resets.
 *
 *   The SAME Telegram account texting from a new chat. `driver_profiles.
 *   telegram_user_id` is a hard anchor: one human, whatever the title says.
 *
 *   A name shared by two drivers who are both still active. That is not a
 *   returning driver; it is two people, and linking either would be a guess.
 *
 * The rule is the backfill's: a Telegram id decides; a name only decides when
 * every other group that name is on has gone inactive; anything else creates a
 * new person and leaves the watchdog to report the coincidence.
 */
const { FLEET_TYPES } = require('../drivers/fleetType');

const NAME_LINK_CONFIDENCE = 70;

/**
 * @param {object} evidence
 * @param {object|null} evidence.open  the group's current open association, if any
 * @param {number|null} evidence.telegramAnchorPersonId  the canonical person of
 *   ANOTHER group whose profile carries the same telegram_user_id
 * @param {Array<{personId:number, openGroupIds:number[]}>} evidence.returningCandidates
 *   canonical people with the same normalized name whose open associations are
 *   all to INACTIVE groups (or who have none)
 * @returns {{action:'keep'|'link'|'create', personId?:number, source?:string,
 *   confidence?:number, closeGroupIds?:number[], ambiguous?:boolean}}
 */
function decidePersonForGroup({ open = null, telegramAnchorPersonId = null, returningCandidates = [] } = {}) {
  if (open && open.personId) return { action: 'keep', personId: open.personId };

  if (telegramAnchorPersonId) {
    return {
      action: 'link',
      personId: telegramAnchorPersonId,
      source: 'telegram_user_id',
      confidence: 100,
      closeGroupIds: [],
    };
  }

  const candidates = Array.isArray(returningCandidates) ? returningCandidates : [];
  if (candidates.length === 1) {
    const [candidate] = candidates;
    return {
      action: 'link',
      personId: candidate.personId,
      source: 'name_key',
      confidence: NAME_LINK_CONFIDENCE,
      // The old chat's association is closed so the person has ONE open group —
      // the invariant every "current group of this person" read relies on.
      closeGroupIds: [...(candidate.openGroupIds || [])],
    };
  }

  // Zero candidates: genuinely new. Two or more: two inactive drivers share a
  // name and only a human can say which one came back — so a new person is
  // created and the coincidence is left for the watchdog to report.
  return { action: 'create', ambiguous: candidates.length > 1 };
}

/**
 * What to do to `driver_units` when a person's unit is observed.
 *
 * @param {object} state
 * @param {string|null} state.currentUnit   the person's open unit, if any
 * @param {string|null} state.targetUnit    the unit now observed on their profile/title
 * @param {number|null} state.holderPersonId  who holds `targetUnit` open right now
 * @param {number} state.personId
 */
/**
 * Is a holder actually in the way?
 *
 * Two known, DIFFERENT fleets on the same number are two different trucks, and
 * nobody is in anybody's way. Anything involving `unknown` IS in the way:
 * unknown never wins a match, so it cannot be used to wave a holder aside.
 */
function holderContests(targetFleetType, holderFleetType) {
  const a = targetFleetType || FLEET_TYPES.UNKNOWN;
  const b = holderFleetType || FLEET_TYPES.UNKNOWN;
  if (a === FLEET_TYPES.UNKNOWN || b === FLEET_TYPES.UNKNOWN) return true;
  return a === b;
}

/**
 * Which truck a person should now be recorded in.
 *
 * A TRUCK IS NOT A NUMBER. It is `(fleet_type, unit_number, seat)`. Company 001,
 * Owner-Operator 001 and Lease 001 are three trucks with three drivers, and
 * production carries ten numbers sitting on more than one active group. Passing
 * only a number is what made those look like one truck being fought over.
 *
 * A TEAM IS TWO PEOPLE ON ONE TRUCK, not a duplicate. When the observation says
 * team and exactly one seat is taken, the answer is the OTHER seat — seat 2 —
 * rather than a contest.
 *
 * `holders` is the list of people already recorded in that number, each with
 * their seat and fleet. `holderPersonId` is the older single-holder form and is
 * still accepted: `services/identity/personResolver.js` passes it until its own
 * lookup becomes fleet-aware, and a caller that knows nothing about fleets gets
 * the strict answer (every holder contests) rather than a permissive one.
 *
 * @returns {{action: 'noop'|'open'|'switch'|'contested', ...}}
 */
function decideUnitSync({
  currentUnit = null,
  targetUnit = null,
  holderPersonId = null,
  holders = null,
  currentFleetType = null,
  targetFleetType = null,
  isTeam = false,
  personId,
}) {
  const target = targetUnit == null ? null : String(targetUnit).trim();
  const current = currentUnit == null ? null : String(currentUnit).trim();
  if (!target) {
    // Nothing observed. An open unit is left alone: "no unit in the title" is
    // absence of evidence, not evidence the driver parked the truck.
    return { action: 'noop', reason: 'no_unit' };
  }
  // The same truck is the same truck. A fleet that now reads differently on an
  // unchanged number is NOT corrected here — retyping an assignment is its own
  // decision with its own evidence, and doing it silently inside a sync would
  // move a driver between fleets on the strength of an edited chat title.
  if (current === target) return { action: 'noop', reason: 'unchanged' };

  const list = Array.isArray(holders) && holders.length
    ? holders
    : (holderPersonId ? [{ personId: holderPersonId, seat: 1, fleetType: null }] : []);

  const blocking = list.filter((h) => h
    && h.personId
    && h.personId !== personId
    && holderContests(targetFleetType, h.fleetType));

  if (blocking.length) {
    const takenSeats = new Set(blocking.map((h) => Number(h.seat) || 1));
    // The other half of a team. Only ever seat 2, and only when seat 1 is the
    // single thing in the way — two people already aboard is a full truck.
    if (isTeam && blocking.length === 1 && !takenSeats.has(2)) {
      return {
        action: current ? 'switch' : 'open',
        from: current, to: target, seat: 2,
        fleetType: targetFleetType || FLEET_TYPES.UNKNOWN,
      };
    }
    // Somebody else is recorded in that truck. Taking it over silently would
    // erase THEIR assignment on the strength of a chat title — the database
    // refuses that (partial unique index), and so does this. It is a finding.
    return {
      action: 'contested',
      holderPersonId: blocking[0].personId,
      holders: blocking.map((h) => ({ personId: h.personId, seat: Number(h.seat) || 1 })),
      unitNumber: target,
      fleetType: targetFleetType || FLEET_TYPES.UNKNOWN,
    };
  }

  return {
    action: current ? 'switch' : 'open',
    from: current, to: target, seat: 1,
    fleetType: targetFleetType || FLEET_TYPES.UNKNOWN,
  };
}

module.exports = {
  decidePersonForGroup, decideUnitSync, holderContests, NAME_LINK_CONFIDENCE,
};
