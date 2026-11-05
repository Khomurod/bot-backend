/**
 * The right truck, recorded under the wrong fleet — brought to the profile.
 *
 *   identity.sync_unit_fleet   answers `identity.unit_fleet_behind_profile`
 *
 * A truck is `(fleet_type, unit_number, seat)`, and the row's fleet is copied
 * from the profile only when the row is OPENED. A person who later changes the
 * profile's driver type (Owner → Company driver) leaves the row behind, and
 * every reader that compares fleets — the Dispatcher Board's driver match first
 * of all — then sees a different truck. In production on 5 November 2026 that
 * was eleven trucks: eight Company drivers recorded Owner-Operator (most in
 * chats titled with the bare `( COMPANY )` the title parser learned only in
 * October) and three Lease drivers recorded Owner-Operator or Company. The
 * owner's decision of that day: the row follows the profile.
 *
 * Copying a fact already held — the profile's driver type, or its chat title
 * when the profile says nothing — like every action in this registry. The
 * evidence is re-read under lock; nothing from the sweep's payload is trusted
 * except as the question.
 *
 * HISTORY IS KEPT. The old row is closed and a new one opened — a row is never
 * edited in place — so what the record said before is still there to read and
 * the revert has something to reopen.
 */
const { resolveDriverType, FLEET_TYPES } = require('../../../lib/drivers/fleetType');
const { holderContests } = require('../../../lib/identity/personResolution');
const { StaleCorrectionError } = require('./evidence');
const people = require('../../../database/driverPeople');

async function openRowsFor(client, personId, unit) {
  const res = await client.query(
    `SELECT id, person_id, unit_number, samsara_vehicle_id, fleet_type, seat
       FROM driver_units
      WHERE ended_at IS NULL AND (person_id = $1 OR unit_number = $2)
      ORDER BY id FOR UPDATE`,
    [personId, unit]
  );
  return res.rows;
}

async function reopen(client, row, { personId, fleetType }) {
  await client.query('UPDATE driver_units SET ended_at = NOW() WHERE id = $1', [row.id]);
  return people.openUnitAssignment({
    personId,
    unitNumber: row.unit_number,
    samsaraVehicleId: row.samsara_vehicle_id || null,
    source: 'profile',
    fleetType,
    seat: Number(row.seat) === 2 ? 2 : 1,
  }, client);
}

const syncUnitFleet = {
  key: 'identity.sync_unit_fleet',
  tier: 'auto',
  subjectType: 'group',
  describe: (p) => `Record unit ${p.unitNumber} as ${p.fleetType} for person ${p.personId}, as the profile says`,

  async apply({
    personId, groupId, unitNumber, fleetType,
  }, client) {
    const unit = String(unitNumber || '').trim();
    if (!unit || !personId || !groupId) throw new StaleCorrectionError('A person, a group and a unit are all required.');

    const profile = await client.query(
      'SELECT unit_number, driver_type FROM driver_profiles WHERE group_id = $1 FOR UPDATE', [groupId]
    );
    if (String(profile.rows[0]?.unit_number || '').trim() !== unit) {
      throw new StaleCorrectionError(`Group ${groupId}'s profile no longer says unit ${unit}.`);
    }
    const group = await client.query(
      'SELECT group_name, active, group_type FROM groups WHERE id = $1 FOR UPDATE', [groupId]
    );
    if (group.rows[0]?.active !== true || group.rows[0]?.group_type !== 'driver') {
      throw new StaleCorrectionError(`Group ${groupId} is no longer an active driver group.`);
    }
    const fleet = resolveDriverType({
      column: profile.rows[0]?.driver_type, title: group.rows[0]?.group_name,
    }).fleetType;
    if (fleet === FLEET_TYPES.UNKNOWN) throw new StaleCorrectionError(`Group ${groupId}'s profile no longer says which fleet.`);
    if (fleetType && fleet !== fleetType) {
      throw new StaleCorrectionError(`Group ${groupId}'s profile now says ${fleet}, not ${fleetType}.`);
    }
    const association = await people.getOpenAssociationForGroup(groupId, client);
    if (!association || association.personId !== Number(personId)) {
      throw new StaleCorrectionError(`Group ${groupId} no longer belongs to person ${personId}.`);
    }
    const activeChats = await client.query(
      `SELECT COUNT(*)::int AS n FROM driver_person_groups pg JOIN groups g ON g.id = pg.group_id
        WHERE pg.person_id = $1 AND pg.ended_at IS NULL AND g.active = TRUE AND g.group_type = 'driver'`,
      [personId]
    );
    if (activeChats.rows[0].n > 1) {
      throw new StaleCorrectionError(`Person ${personId} is on ${activeChats.rows[0].n} active chats — which truck is a decision.`);
    }

    const rows = await openRowsFor(client, personId, unit);
    const current = rows.find((r) => Number(r.person_id) === Number(personId) && String(r.unit_number).trim() === unit);
    if (!current) throw new StaleCorrectionError(`Person ${personId} is no longer recorded in unit ${unit}.`);
    if ((current.fleet_type || FLEET_TYPES.UNKNOWN) === fleet) {
      throw new StaleCorrectionError(`Unit ${unit} is already recorded as ${fleet}.`);
    }
    const holder = rows.find((r) => Number(r.person_id) !== Number(personId)
      && String(r.unit_number).trim() === unit && holderContests(fleet, r.fleet_type));
    if (holder) {
      throw new StaleCorrectionError(`Person ${holder.person_id} holds ${fleet} unit ${unit} — two people in one truck is a decision.`);
    }

    const opened = await reopen(client, current, { personId: Number(personId), fleetType: fleet });
    return {
      oldValues: { unitRowId: current.id, unitNumber: unit, fleetType: current.fleet_type || FLEET_TYPES.UNKNOWN },
      newValues: { unitRowId: opened.id, unitNumber: unit, fleetType: fleet, personId: Number(personId) },
      affectedRecords: [
        { table: 'driver_units', id: current.id, personId: Number(personId) },
        { table: 'driver_units', id: opened.id, personId: Number(personId) },
      ],
    };
  },

  /** Close the row this opened and open one with the old fleet again — never an edit of history. */
  async revert(correction, client) {
    const openedId = correction.new_values?.unitRowId;
    const oldFleet = correction.old_values?.fleetType;
    const res = await client.query(
      'SELECT id, person_id, unit_number, samsara_vehicle_id, fleet_type, seat FROM driver_units WHERE id = $1 AND ended_at IS NULL FOR UPDATE',
      [openedId]
    );
    const row = res.rows[0];
    if (!row) throw new StaleCorrectionError('The unit row this correction opened is no longer open.');
    const others = await openRowsFor(client, row.person_id, row.unit_number);
    const inWay = others.find((r) => Number(r.id) !== Number(row.id) && Number(r.person_id) !== Number(row.person_id)
      && String(r.unit_number).trim() === String(row.unit_number).trim() && holderContests(oldFleet, r.fleet_type));
    if (inWay) throw new StaleCorrectionError(`Person ${inWay.person_id} now holds that truck in the old fleet.`);
    await reopen(client, row, { personId: Number(row.person_id), fleetType: oldFleet });
  },
};

module.exports = { syncUnitFleet };
