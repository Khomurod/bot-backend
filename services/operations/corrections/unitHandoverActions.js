/**
 * Handing a departed driver's truck to the driver who now has it.
 *
 *   identity.hand_over_unit   a truck still recorded to somebody with no active
 *                             chat anywhere passes to the one active chat whose
 *                             profile claims it.
 *
 * WHY THIS MAY RUN WITHOUT A PERSON. `identity.unit_contested` exists so that a
 * chat title can never evict a driver who is still working; that stays true.
 * What it was also catching was the commonest event in a fleet — a driver
 * leaves, a new hire gets the truck — and every one became a question. On 20
 * October 2026 the owner answered ten of them, each the same way, and asked for
 * the rest to be done automatically. The departure is the evidence: the old
 * holder's chats are all inactive, which a person decided, and the new
 * driver's profile names the truck, which a person typed.
 *
 * IT RE-CHECKS UNDER LOCK. Between the sweep and the apply the old driver may
 * have come back (an active chat again), somebody else may have taken the
 * truck, or the new driver's profile may have moved on. Any of those and it
 * refuses, leaving the question for the next sweep.
 *
 * REVERT puts the history back as new rows, never by editing closed ones: the
 * new driver's assignment is closed, the old holders' trucks are reopened, and
 * the new driver's previous truck (if any) is reopened.
 */
const { resolveDriverType } = require('../../../lib/drivers/fleetType');
const { holderContests } = require('../../../lib/identity/personResolution');
const { StaleCorrectionError } = require('./evidence');
const people = require('../../../database/driverPeople');

async function activeChatCount(personId, client) {
  const res = await client.query(
    `SELECT COUNT(*)::int AS n FROM driver_person_groups pg JOIN groups g ON g.id = pg.group_id
      WHERE pg.person_id = $1 AND pg.ended_at IS NULL AND g.active = TRUE AND g.group_type = 'driver'`,
    [personId]
  );
  return res.rows[0].n;
}

const handOverUnit = {
  key: 'identity.hand_over_unit',
  tier: 'auto',
  subjectType: 'group',
  describe: (p) => `Hand unit ${p.unitNumber} to person ${p.personId}; its recorded driver has left`,

  async apply({
    personId, groupId, unitNumber, holderPersonIds = [],
  }, client) {
    const unit = String(unitNumber || '').trim();
    if (!unit || !personId || !groupId) throw new StaleCorrectionError('A person, a chat and a unit are all required.');

    const groupRow = await client.query(
      `SELECT g.group_name, g.group_type, g.active, g.samsara_vehicle_id, dp.unit_number, dp.driver_type
         FROM groups g LEFT JOIN driver_profiles dp ON dp.group_id = g.id
        WHERE g.id = $1 FOR UPDATE OF g`,
      [groupId]
    );
    const group = groupRow.rows[0];
    if (!group || group.group_type !== 'driver' || group.active !== true) {
      throw new StaleCorrectionError(`Group ${groupId} is no longer an active driver chat.`);
    }
    if (String(group.unit_number || '').trim() !== unit) {
      throw new StaleCorrectionError(`Group ${groupId}'s profile no longer says unit ${unit}.`);
    }
    const association = await people.getOpenAssociationForGroup(groupId, client);
    if (!association || association.personId !== Number(personId)) {
      throw new StaleCorrectionError(`Group ${groupId} no longer belongs to person ${personId}.`);
    }
    if (await activeChatCount(personId, client) !== 1) {
      throw new StaleCorrectionError(`Person ${personId} is not on exactly one active chat — which truck is a decision.`);
    }

    const fleetType = resolveDriverType({ column: group.driver_type, title: group.group_name }).fleetType;
    const openRows = await client.query(
      `SELECT id, person_id, unit_number, samsara_vehicle_id, fleet_type, seat, started_at
         FROM driver_units
        WHERE ended_at IS NULL AND (person_id = $1 OR unit_number = $2)
        ORDER BY id FOR UPDATE`,
      [personId, unit]
    );
    const inWay = openRows.rows.filter((r) => String(r.unit_number).trim() === unit
      && Number(r.person_id) !== Number(personId)
      && holderContests(fleetType, r.fleet_type));
    if (!inWay.length) throw new StaleCorrectionError(`Nobody else holds unit ${unit} any more.`);
    const expected = new Set(holderPersonIds.map(Number));
    for (const row of inWay) {
      if (!expected.has(Number(row.person_id))) {
        throw new StaleCorrectionError(`Unit ${unit} is now held by person ${row.person_id}, who was not in the proposal.`);
      }
      // eslint-disable-next-line no-await-in-loop
      if (await activeChatCount(row.person_id, client) > 0) {
        throw new StaleCorrectionError(`Person ${row.person_id} has an active chat again — not taking their truck.`);
      }
    }

    const current = openRows.rows.find((r) => Number(r.person_id) === Number(personId)) || null;
    if (current && String(current.unit_number).trim() === unit) {
      throw new StaleCorrectionError(`Person ${personId} already holds unit ${unit}.`);
    }

    await client.query('UPDATE driver_units SET ended_at = NOW() WHERE id = ANY($1::bigint[])', [inWay.map((r) => r.id)]);
    if (current) await client.query('UPDATE driver_units SET ended_at = NOW() WHERE id = $1', [current.id]);
    const opened = await people.openUnitAssignment({
      personId, unitNumber: unit, samsaraVehicleId: group.samsara_vehicle_id || null, source: 'profile', fleetType,
    }, client);

    return {
      oldValues: {
        unitNumber: current ? current.unit_number : null,
        unitRowId: current ? current.id : null,
        samsaraVehicleId: current ? current.samsara_vehicle_id : null,
        fleetType: current ? current.fleet_type : null,
        holders: inWay.map((r) => ({
          personId: r.person_id, unitRowId: r.id, unitNumber: r.unit_number,
          samsaraVehicleId: r.samsara_vehicle_id, fleetType: r.fleet_type, seat: r.seat,
        })),
      },
      newValues: {
        unitNumber: unit, unitRowId: opened.id, samsaraVehicleId: group.samsara_vehicle_id || null, personId: Number(personId),
      },
      affectedRecords: [
        { table: 'driver_units', id: opened.id, personId: Number(personId) },
        ...inWay.map((r) => ({ table: 'driver_units', id: r.id, personId: r.person_id })),
      ],
    };
  },

  async revert(correction, client) {
    const nv = correction.new_values || {};
    const ov = correction.old_values || {};
    const res = await client.query(
      'UPDATE driver_units SET ended_at = NOW() WHERE id = $1 AND ended_at IS NULL RETURNING id',
      [nv.unitRowId]
    );
    if (res.rowCount === 0) throw new StaleCorrectionError('The assignment this handover opened is no longer open.');
    for (const h of ov.holders || []) {
      // eslint-disable-next-line no-await-in-loop
      await people.openUnitAssignment({
        personId: h.personId, unitNumber: h.unitNumber, samsaraVehicleId: h.samsaraVehicleId || null,
        source: 'manual', fleetType: h.fleetType, seat: h.seat,
      }, client);
    }
    if (ov.unitNumber) {
      await people.openUnitAssignment({
        personId: nv.personId, unitNumber: ov.unitNumber, samsaraVehicleId: ov.samsaraVehicleId || null,
        source: 'manual', fleetType: ov.fleetType,
      }, client);
    }
  },
};

module.exports = { handOverUnit };
