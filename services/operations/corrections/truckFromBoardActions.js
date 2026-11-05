/**
 * Copy the truck the Dispatcher Board names for a driver onto the driver's
 * profile — its fleet and, for an owner's truck, its owner.
 *
 *   identity.set_truck_from_board   answers `identity.truck_from_board`
 *
 * The rules are the check's (`checks/truckFromBoard.js`): same person, same
 * number, one board line, never over a truck a person set by hand. Every one is
 * re-read here under lock; the sweep's payload is only the question. The truck
 * record itself follows on the next sweep through
 * `identity.unit_fleet_behind_profile`, so this writes one row and one row only.
 *
 * Revertible: the before-image is the profile's three truck fields, and the
 * revert restores them only while they still hold what this wrote.
 */
const { StaleCorrectionError } = require('./evidence');
const { truckFromBoardRow, normaliseOwner } = require('../../../lib/drivers/truckIdentity');
const { namesAgreeStrictly } = require('../../../lib/identity/boardResolution');

const unitKey = (u) => String(u || '').trim().toUpperCase();

const setTruckFromBoard = {
  key: 'identity.set_truck_from_board',
  tier: 'auto',
  subjectType: 'group',
  describe: (p) => `Record the board's truck ${p.boardTruck} on group ${p.groupId}'s profile`,

  async apply({
    groupId, unitNumber, boardTruck, fleetType, truckOwner,
  }, client) {
    if (!groupId || !unitNumber || !boardTruck || !fleetType) {
      throw new StaleCorrectionError('A chat, its unit, the board truck and its fleet are all required.');
    }
    const prof = await client.query(
      `SELECT dp.unit_number, dp.first_name, dp.last_name, dp.secondary_first_name, dp.secondary_last_name,
              dp.truck_fleet, dp.truck_owner, dp.truck_source, g.active, g.group_type
         FROM driver_profiles dp JOIN groups g ON g.id = dp.group_id
        WHERE dp.group_id = $1 FOR UPDATE OF dp`,
      [groupId]
    );
    const p = prof.rows[0];
    if (!p || p.active !== true || p.group_type !== 'driver') throw new StaleCorrectionError(`Group ${groupId} is no longer an active driver chat.`);
    if (unitKey(p.unit_number) !== unitKey(unitNumber)) throw new StaleCorrectionError(`Group ${groupId}'s profile no longer says unit ${unitNumber}.`);
    if (p.truck_source === 'manual') throw new StaleCorrectionError(`A person set group ${groupId}'s truck by hand — not overwriting it.`);

    const board = await client.query(
      `SELECT truck_raw, truck_norm, fleet_type, fleet_label_raw, driver_name_clean, team_members
         FROM dispatch_board_rows WHERE present = TRUE AND truck_raw = $1`,
      [boardTruck]
    );
    const person = await client.query(
      `SELECT dpp.display_name FROM driver_person_groups pg JOIN driver_people dpp ON dpp.id = pg.person_id
        WHERE pg.group_id = $1 AND pg.ended_at IS NULL`,
      [groupId]
    );
    // The same names the check compared: the profile's, and the person's.
    const names = [
      [p.first_name, p.last_name].filter(Boolean).join(' '),
      [p.secondary_first_name, p.secondary_last_name].filter(Boolean).join(' '),
      ...person.rows.map((r) => r.display_name),
    ].filter(Boolean).flatMap((n) => String(n).split('/').map((x) => x.trim()).filter(Boolean));
    const row = board.rows.find((r) => unitKey(r.truck_norm) === unitKey(unitNumber)
      && (Array.isArray(r.team_members) && r.team_members.length ? r.team_members : [r.driver_name_clean])
        .some((b) => names.some((n) => namesAgreeStrictly(b, n))));
    if (!row) throw new StaleCorrectionError(`The board no longer has this driver in ${boardTruck}.`);
    const truck = truckFromBoardRow(row);
    if (truck.fleetType !== fleetType || truck.owner !== normaliseOwner(truckOwner)) {
      throw new StaleCorrectionError(`The board now says ${row.truck_raw} is a different truck.`);
    }

    await client.query(
      `UPDATE driver_profiles
          SET truck_fleet = $2, truck_owner = $3, truck_source = 'board', truck_updated_at = NOW(), updated_at = NOW()
        WHERE group_id = $1`,
      [groupId, truck.fleetType, truck.owner]
    );
    return {
      oldValues: { truckFleet: p.truck_fleet || null, truckOwner: p.truck_owner || null, truckSource: p.truck_source || null },
      newValues: {
        truckFleet: truck.fleetType, truckOwner: truck.owner, truckSource: 'board', boardTruck: row.truck_raw,
      },
      affectedRecords: [{ table: 'driver_profiles', groupId: Number(groupId) }],
    };
  },

  async revert(correction, client) {
    const groupId = Number(correction.subject_id);
    const nv = correction.new_values || {};
    const ov = correction.old_values || {};
    const res = await client.query(
      'SELECT truck_fleet, truck_owner, truck_source FROM driver_profiles WHERE group_id = $1 FOR UPDATE', [groupId]
    );
    const now = res.rows[0];
    if (!now || now.truck_fleet !== nv.truckFleet || (now.truck_owner || null) !== (nv.truckOwner || null)) {
      throw new StaleCorrectionError(`Group ${groupId}'s truck changed since — leaving it alone.`);
    }
    await client.query(
      `UPDATE driver_profiles SET truck_fleet = $2, truck_owner = $3, truck_source = $4, truck_updated_at = NOW(), updated_at = NOW()
        WHERE group_id = $1`,
      [groupId, ov.truckFleet || null, ov.truckOwner || null, ov.truckSource || null]
    );
  },
};

module.exports = { setTruckFromBoard };
