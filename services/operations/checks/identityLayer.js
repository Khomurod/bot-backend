/**
 * Person-layer checks — pure, no I/O.
 *
 * Phase 3-E made `driver_people` the thing the application writes and reads.
 * These checks are what keeps it HONEST: every one compares the person layer
 * with the chat/profile layer beside it and reports where they disagree.
 *
 * Two of them are auto-correctable, and both pass the registry's test — the
 * corrected value is already recorded somewhere else:
 *
 *   A driver group with no person. The resolver places a group when the bot
 *   hears from it; a group nobody has texted in since the layer arrived never
 *   gets placed. The fix is the resolver itself, run from the sweep.
 *
 *   A person whose recorded truck is not the one on their profile, when the
 *   profile's truck is held by nobody. The profile IS the record; the person
 *   layer is behind it.
 *
 * The other two are for a human: the same person on two active chats, and a
 * truck the profile claims that another person still holds.
 */
const { resolveDriverType, FLEET_TYPES } = require('../../../lib/drivers/fleetType');

function activeDriverGroups(groups) {
  return groups.filter((g) => g.group_type === 'driver' && g.active === true);
}

function openByGroup(personGroups) {
  return new Map((personGroups || []).map((a) => [a.group_id, a]));
}

function profilesByGroup(profiles) {
  return new Map((profiles || []).map((p) => [p.group_id, p]));
}

function unitsByPerson(units) {
  return new Map((units || []).map((u) => [u.person_id, u]));
}

/**
 * Every open assignment of a unit NUMBER, keyed by the number.
 *
 * A LIST, not a single row. `new Map(...)` over a number kept whichever row came
 * last and silently dropped the rest, which is fine only while a number is a
 * truck — and it is not: Company 001, Owner-Operator 001 and Lease 001 are
 * three. Which of these holders is actually in the way is decided per check,
 * from the fleet each one carries.
 */
function unitsByNumber(units) {
  const map = new Map();
  for (const u of units || []) {
    const key = String(u.unit_number).trim();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(u);
  }
  return map;
}

/**
 * The holders of `unit` that a claimant in `fleet` would actually collide with.
 *
 * Two known, different fleets are two different trucks. `unknown` on either side
 * collides, because it cannot be used to prove they are different either.
 */
function holdersInWay(holders, fleet) {
  const target = fleet || FLEET_TYPES.UNKNOWN;
  return (holders || []).filter((h) => {
    const held = h.fleet_type || FLEET_TYPES.UNKNOWN;
    if (target === FLEET_TYPES.UNKNOWN || held === FLEET_TYPES.UNKNOWN) return true;
    return target === held;
  });
}

function label(group) {
  return group.group_name || `Group ${group.id}`;
}

/** An active driver group the person layer has never placed. */
function checkGroupWithoutPerson({ groups, personGroups }) {
  const open = openByGroup(personGroups);
  return activeDriverGroups(groups)
    .filter((g) => !open.has(g.id))
    .map((g) => ({
      checkKey: 'identity.group_without_person',
      subjectType: 'group',
      subjectId: g.id,
      title: `${label(g)} has no permanent driver identity yet`,
      severity: 'info',
      tier: 'auto',
      confidence: 90,
      evidence: { groupId: g.id, groupName: g.group_name },
      proposedChange: { table: 'driver_person_groups', groupId: g.id, action: 'ensure_person' },
    }));
}

/**
 * One person, two (or more) ACTIVE chats.
 *
 * Legitimate for a moment — a driver's new chat is created before the old one is
 * retired — and a defect when it lasts. Only a person can say which chat is the
 * live one, so this is reported, never corrected.
 */
function checkPersonOnTwoActiveGroups({ groups, personGroups, people }) {
  const active = new Map(activeDriverGroups(groups).map((g) => [g.id, g]));
  const byPerson = new Map();
  for (const a of personGroups || []) {
    if (!active.has(a.group_id)) continue;
    if (!byPerson.has(a.person_id)) byPerson.set(a.person_id, []);
    byPerson.get(a.person_id).push(active.get(a.group_id));
  }
  const names = new Map((people || []).map((p) => [p.id, p.display_name]));
  const findings = [];
  for (const [personId, held] of byPerson) {
    if (held.length < 2) continue;
    findings.push({
      checkKey: 'identity.person_on_two_active_groups',
      subjectType: 'person',
      subjectId: personId,
      title: `${names.get(personId) || `Person ${personId}`} is on ${held.length} active driver groups`,
      severity: 'warning',
      tier: 'warning',
      evidence: {
        personId,
        displayName: names.get(personId) || null,
        groups: held.map((g) => ({ groupId: g.id, groupName: g.group_name })),
      },
    });
  }
  return findings;
}

/**
 * The truck on a group's profile is recorded to a DIFFERENT person.
 *
 * This is the contradiction the resolver refuses to resolve by itself: a chat
 * title must not evict the driver the layer says is in the truck. Somebody
 * decides.
 */
function checkUnitContested({ groups, profiles, personGroups, units, people }) {
  const open = openByGroup(personGroups);
  const byGroup = profilesByGroup(profiles);
  const holders = unitsByNumber(units);
  const names = new Map((people || []).map((p) => [p.id, p.display_name]));
  const findings = [];
  for (const g of activeDriverGroups(groups)) {
    const association = open.get(g.id);
    const unit = String(byGroup.get(g.id)?.unit_number || '').trim();
    if (!association || !unit) continue;
    const fleet = resolveDriverType({
      column: byGroup.get(g.id)?.driver_type, title: g.group_name,
    }).fleetType;
    const contenders = holdersInWay(holders.get(unit), fleet)
      .filter((h) => h.person_id !== association.person_id);
    const holder = contenders[0];
    if (!holder) continue;
    findings.push({
      checkKey: 'identity.unit_contested',
      subjectType: 'group',
      subjectId: g.id,
      title: `${label(g)} claims unit ${unit}, which is recorded to ${names.get(holder.person_id) || `person ${holder.person_id}`}`,
      severity: 'warning',
      tier: 'warning',
      evidence: {
        groupId: g.id,
        groupName: g.group_name,
        unitNumber: unit,
        fleetType: fleet,
        groupPersonId: association.person_id,
        holderPersonId: holder.person_id,
        holderDisplayName: names.get(holder.person_id) || null,
        holderFleetType: holder.fleet_type || FLEET_TYPES.UNKNOWN,
      },
    });
  }
  return findings;
}

/**
 * The person's recorded truck is behind their profile, and nobody else holds
 * the profile's truck. The profile is the record; sync the layer to it.
 */
/**
 * What the Dispatcher Board says about each person's truck today.
 *
 * Keyed by person, because the question asked below is "does the board agree
 * with the truck the profile names for THIS driver" — not "who is in truck X",
 * which is `unitsByNumber`'s job.
 */
function boardTruckByPerson(boardRows) {
  const out = new Map();
  for (const r of boardRows || []) {
    if (!r || !r.present || r.personId == null || !r.truckNorm) continue;
    // Newest presence wins; a person on two present rows is a team seat or a
    // board problem, and either way the first is as good an answer as exists.
    if (!out.has(r.personId)) out.set(r.personId, r);
  }
  return out;
}

function checkStaleUnitAssignment({ groups, profiles, personGroups, units, boardRows }) {
  const open = openByGroup(personGroups);
  const byGroup = profilesByGroup(profiles);
  const holders = unitsByNumber(units);
  const current = unitsByPerson(units);
  // A person on two active chats is ambiguous evidence: each chat's profile
  // would sync them to a different truck, and two auto findings would switch
  // them back and forth every sweep. That conflict is its own finding
  // (person_on_two_active_groups); nothing is synced until a person settles it.
  const activeIds = new Set(activeDriverGroups(groups).map((g) => g.id));
  const activeChatsOf = new Map();
  for (const a of personGroups || []) {
    if (activeIds.has(a.group_id)) activeChatsOf.set(a.person_id, (activeChatsOf.get(a.person_id) || 0) + 1);
  }
  const board = boardTruckByPerson(boardRows);
  const findings = [];
  for (const g of activeDriverGroups(groups)) {
    const association = open.get(g.id);
    const unit = String(byGroup.get(g.id)?.unit_number || '').trim();
    if (!association || !unit) continue;
    if ((activeChatsOf.get(association.person_id) || 0) > 1) continue;
    const recorded = current.get(association.person_id);
    if (recorded && String(recorded.unit_number).trim() === unit) continue;
    const staleFleet = resolveDriverType({
      column: byGroup.get(g.id)?.driver_type, title: g.group_name,
    }).fleetType;
    // Only a holder in the SAME truck blocks the sync. One in another fleet is
    // in another truck, and leaving the assignment stale because of them would
    // be the bare-number mistake in a new place.
    const blocking = holdersInWay(holders.get(unit), staleFleet)
      .filter((h) => h.person_id !== association.person_id);
    if (blocking.length) continue; // contested — the check above

    // ── what the board says about the same driver ─────────────────────────
    //
    // THE BOARD DISAGREEING IS A HOLD, NOT A VOTE. When the board names a
    // different truck from the profile, two systems that both watch today's
    // assignment disagree, and the profile is no longer enough on its own — so
    // the automatic finding is SUPPRESSED for this group and a question is
    // filed in its place. Letting the auto finding stand would have Wenze
    // quietly sync to the profile while the board said something else; letting
    // the board win would make a spreadsheet the authority on permanent
    // identity, which it is not.
    //
    // A board that AGREES raises confidence: two independent sources, and the
    // `sources` list the journal grades records both.
    const boardRow = board.get(association.person_id);
    const boardTruck = boardRow ? String(boardRow.truckNorm).trim() : null;
    if (boardTruck && boardTruck !== unit) {
      findings.push({
        checkKey: 'board.truck_disagrees_with_profile',
        subjectType: 'group',
        subjectId: g.id,
        title: `${label(g)}: the profile says unit ${unit}, the dispatcher board says ${boardTruck}`,
        severity: 'warning',
        tier: 'approval',
        confidence: 100,
        evidence: {
          groupId: g.id,
          personId: association.person_id,
          profileUnit: unit,
          boardTruck,
          recordedUnit: recorded ? recorded.unit_number : null,
          boardSeenAt: boardRow.lastSeenAt || null,
        },
        // NOTHING IS PROPOSED. Neither source is evidence about the other, and
        // a person decides which is out of date.
        proposedChange: null,
      });
      continue;
    }

    const corroborated = Boolean(boardTruck && boardTruck === unit);
    findings.push({
      checkKey: 'identity.stale_unit_assignment',
      subjectType: 'group',
      subjectId: g.id,
      title: `${label(g)}: profile says unit ${unit}, the driver's record says ${recorded ? recorded.unit_number : 'no truck'}`,
      severity: 'info',
      tier: 'auto',
      // 95 when the board says the same truck, 90 on the profile alone. Small
      // on purpose: the board agreeing is corroboration, not proof, and a jump
      // large enough to change what the journal permits would make a
      // spreadsheet the thing that unlocked an automatic write.
      confidence: corroborated ? 95 : 90,
      evidence: {
        groupId: g.id,
        personId: association.person_id,
        profileUnit: unit,
        recordedUnit: recorded ? recorded.unit_number : null,
        boardAgrees: corroborated,
        ...(corroborated ? { boardTruck } : {}),
      },
      proposedChange: {
        table: 'driver_units', personId: association.person_id, groupId: g.id,
        from: recorded ? recorded.unit_number : null, to: unit,
      },
    });
  }
  return findings;
}

const CHECKS = [
  checkGroupWithoutPerson,
  checkPersonOnTwoActiveGroups,
  checkUnitContested,
  checkStaleUnitAssignment,
];

const CHECK_KEYS = [
  'identity.group_without_person',
  'identity.person_on_two_active_groups',
  'identity.unit_contested',
  'identity.stale_unit_assignment',
  'board.truck_disagrees_with_profile',
];

function runIdentityLayerChecks(snapshot) {
  return CHECKS.flatMap((check) => check(snapshot));
}

module.exports = {
  CHECK_KEYS,
  runIdentityLayerChecks,
  checkGroupWithoutPerson,
  checkPersonOnTwoActiveGroups,
  checkUnitContested,
  checkStaleUnitAssignment,
};
