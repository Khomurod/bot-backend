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
function decideUnitSync({ currentUnit = null, targetUnit = null, holderPersonId = null, personId }) {
  const target = targetUnit == null ? null : String(targetUnit).trim();
  const current = currentUnit == null ? null : String(currentUnit).trim();
  if (!target) {
    // Nothing observed. An open unit is left alone: "no unit in the title" is
    // absence of evidence, not evidence the driver parked the truck.
    return { action: 'noop', reason: 'no_unit' };
  }
  if (current === target) return { action: 'noop', reason: 'unchanged' };
  if (holderPersonId && holderPersonId !== personId) {
    // Somebody else is recorded in that truck. Taking it over silently would
    // erase THEIR assignment on the strength of a chat title — the database
    // refuses that (partial unique index), and so does this. It is a finding.
    return { action: 'contested', holderPersonId, unitNumber: target };
  }
  return { action: current ? 'switch' : 'open', from: current, to: target };
}

module.exports = { decidePersonForGroup, decideUnitSync, NAME_LINK_CONFIDENCE };
