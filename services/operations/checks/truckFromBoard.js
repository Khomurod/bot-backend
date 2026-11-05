/**
 * The truck a driver is in, as the Dispatcher Board writes it — copied onto the
 * driver's profile. Pure, no I/O.
 *
 *   identity.truck_from_board   auto (owner's decision, 5 November 2026)
 *
 * The board is the authority on which truck each driver is in today
 * (`docs/architecture/dispatcher-board.md`), and its truck label carries two
 * things Wenze's profile could not: the truck's OWNER ("1 ROGER" — the name
 * after the number is the owner, not the driver) and the truck's own FLEET,
 * which for a driver hired by an owner is not the driver's type ("by the truck
 * an owner-operator, by the driver a company driver"). This check finds a chat
 * whose driver the board names on the profile's own number, and proposes the
 * board's truck; `identity.unit_fleet_behind_profile` then brings the truck
 * record to the profile.
 *
 * ONLY WHEN IT IS THE SAME PERSON ON THE SAME NUMBER: the profile's unit exactly
 * equals the board line's unit, the names agree by the board match's STRICT
 * rule, and exactly one present line does. A different number, a looser name or
 * two candidate lines is a question for a person, never a copy. A truck a person
 * set by hand (`truck_source = 'manual'`) is never overwritten.
 *
 * Nothing is filed when the profile already means that truck — the same fleet
 * and owner, whether recorded or implied by the driver's type — so a company
 * driver in a company truck costs nothing.
 *
 * A LINE WITH NO SUFFIX IS ASKED, NOT COPIED, WHEN IT CONTRADICTS THE DRIVER.
 * The board reads a number with nothing after it as an owner-operator truck —
 * the owner-operator driving his own truck. A COMPANY or LEASE driver on such a
 * line is far more likely a suffix the dispatcher lost than an owner's truck:
 * an owner's truck a company driver is hired into carries the owner's name
 * ("077 (Polvan)"). On 5 November 2026 "888" lost its "CMP" and the first pass
 * copied owner-operator onto a company driver's profile. So that one shape is
 * filed as an approval-tier question naming the missing suffix, and only a
 * person's Yes copies it.
 */
const { FLEET_TYPES, resolveDriverType } = require('../../../lib/drivers/fleetType');
const { truckFromBoardRow, truckOfProfile, normaliseOwner } = require('../../../lib/drivers/truckIdentity');
const { namesAgreeStrictly } = require('../../../lib/identity/boardResolution');

const CHECK_KEYS = ['identity.truck_from_board'];

const unitKey = (u) => String(u || '').trim().toUpperCase();

function profileNames(profile, personName) {
  const names = [
    [profile?.first_name, profile?.last_name].filter(Boolean).join(' '),
    [profile?.secondary_first_name, profile?.secondary_last_name].filter(Boolean).join(' '),
    personName,
  ];
  return names.map((n) => String(n || '').trim()).filter(Boolean)
    .flatMap((n) => n.split('/').map((s) => s.trim()).filter(Boolean));
}

function boardNames(row) {
  const team = Array.isArray(row.team_members) ? row.team_members.filter(Boolean) : [];
  return team.length ? team : [row.driver_name_clean].filter(Boolean);
}

function runTruckFromBoardChecks({
  groups = [], profiles = [], personGroups = [], people = [], boardRows = null,
}) {
  if (!Array.isArray(boardRows)) return []; // the board could not be read: say nothing
  const byGroup = new Map(profiles.map((p) => [p.group_id, p]));
  const personOf = new Map(personGroups.map((a) => [a.group_id, a.person_id]));
  const nameOf = new Map(people.map((p) => [p.id, p.display_name]));
  const byUnit = new Map();
  for (const row of boardRows) {
    const k = unitKey(row.truck_norm);
    if (!k) continue;
    if (!byUnit.has(k)) byUnit.set(k, []);
    byUnit.get(k).push(row);
  }

  const findings = [];
  for (const g of groups) {
    if (g.group_type !== 'driver' || g.active !== true) continue;
    const profile = byGroup.get(g.id);
    const personId = personOf.get(g.id);
    const unit = unitKey(profile?.unit_number);
    if (!profile || !personId || !unit) continue;
    if (profile.truck_source === 'manual') continue;

    const chatNames = profileNames(profile, nameOf.get(personId));
    const matches = (byUnit.get(unit) || [])
      .filter((row) => boardNames(row).some((b) => chatNames.some((c) => namesAgreeStrictly(b, c))));
    if (matches.length !== 1) continue;
    const [row] = matches;
    const board = truckFromBoardRow(row);
    if (board.fleetType === FLEET_TYPES.UNKNOWN) continue;
    const now = truckOfProfile(profile, g.group_name);
    if (now.fleetType === board.fleetType && now.owner === board.owner) continue;
    const driverFleet = resolveDriverType({ column: profile.driver_type ?? null, title: g.group_name }).fleetType;
    const suffixMissing = !normaliseOwner(row.fleet_label_raw)
      && board.fleetType === FLEET_TYPES.OWNER_OPERATOR
      && (driverFleet === FLEET_TYPES.COMPANY || driverFleet === FLEET_TYPES.LEASE);

    findings.push({
      checkKey: 'identity.truck_from_board',
      subjectType: 'group',
      subjectId: g.id,
      title: suffixMissing
        ? `${g.group_name || `Group ${g.id}`}: the board writes ${row.truck_raw} with no suffix, but the driver is not an owner-operator`
        : `${g.group_name || `Group ${g.id}`}: the board has this driver in ${row.truck_raw}`,
      severity: 'info',
      tier: suffixMissing ? 'approval' : 'auto',
      confidence: suffixMissing ? 60 : 90,
      evidence: {
        groupId: g.id,
        groupName: g.group_name,
        personId,
        unitNumber: profile.unit_number,
        boardTruck: row.truck_raw,
        boardDriver: boardNames(row).join(' / '),
        profileFleet: now.fleetType,
        profileOwner: now.owner,
        boardFleet: board.fleetType,
        boardOwner: board.owner,
        driverFleet,
        boardSuffixMissing: suffixMissing,
      },
      proposedChange: {
        table: 'driver_profiles',
        groupId: g.id,
        unitNumber: profile.unit_number,
        boardTruck: row.truck_raw,
        toFleet: board.fleetType,
        toOwner: board.owner,
      },
    });
  }
  return findings;
}

module.exports = { CHECK_KEYS, runTruckFromBoardChecks };
