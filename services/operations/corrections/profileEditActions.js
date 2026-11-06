/**
 * Profile edits a person confirmed in the notification group — the owner's own
 * words, read into a change and put back to them as an exact question
 * (`lib/control/changeCatalogue.js`, `services/control/confirmChange.js`).
 *
 *   profile.set_unit    the truck number on the chat's profile
 *   profile.set_truck   the truck's fleet and owner (beside the driver's type)
 *
 * APPROVAL ONLY. The system cannot apply either (`apply.js` refuses a non-auto
 * action initiated by the system); they run when the owner answers Yes to the
 * change they were shown. Each re-reads the profile under lock and refuses when
 * it no longer holds what the question showed, so a Yes to a stale question
 * changes nothing.
 *
 * WHAT FOLLOWS: the truck record (`driver_units`) is brought to the profile by
 * the sweep's own repairs — `identity.stale_unit_assignment` for a new number,
 * `identity.unit_fleet_behind_profile` for a new fleet or owner — the same path
 * an administrator's edit in Driver Groups takes. Revertible while the profile
 * still holds what this wrote.
 */
const { StaleCorrectionError } = require('./evidence');
const { normaliseOwner } = require('../../../lib/drivers/truckIdentity');

const FLEETS = new Set(['company', 'owner_operator', 'lease']);
const unitOf = (v) => (v == null ? null : String(v).trim().toUpperCase() || null);

async function lockProfile(client, groupId, columns) {
  const res = await client.query(
    `SELECT ${columns.map((c) => `dp.${c}`).join(', ')}, g.active, g.group_type
       FROM driver_profiles dp JOIN groups g ON g.id = dp.group_id
      WHERE dp.group_id = $1 FOR UPDATE OF dp`,
    [groupId]
  );
  const p = res.rows[0];
  if (!p || p.active !== true || p.group_type !== 'driver') {
    throw new StaleCorrectionError(`Group ${groupId} is no longer an active driver chat.`);
  }
  return p;
}

const setUnit = {
  key: 'profile.set_unit',
  tier: 'approval',
  subjectType: 'group',
  describe: (p) => `Set group ${p.groupId}'s unit to ${p.unitNumber}`,

  async apply({ groupId, unitNumber, from }, client) {
    const unit = unitOf(unitNumber);
    if (!groupId || !unit || !/^\d{1,6}[A-Z]?$/.test(unit)) throw new StaleCorrectionError('A chat and a truck number are both required.');
    const p = await lockProfile(client, groupId, ['unit_number']);
    if (unitOf(p.unit_number) !== unitOf(from)) {
      throw new StaleCorrectionError(`Group ${groupId}'s profile now says unit ${p.unit_number || 'none'}, not ${from || 'none'}.`);
    }
    if (unitOf(p.unit_number) === unit) throw new StaleCorrectionError(`Group ${groupId} already says unit ${unit}.`);
    await client.query('UPDATE driver_profiles SET unit_number = $2, updated_at = NOW() WHERE group_id = $1', [groupId, unit]);
    return {
      oldValues: { unitNumber: p.unit_number || null },
      newValues: { unitNumber: unit },
      affectedRecords: [{ table: 'driver_profiles', groupId: Number(groupId) }],
    };
  },

  async revert(correction, client) {
    const groupId = Number(correction.subject_id);
    const res = await client.query('SELECT unit_number FROM driver_profiles WHERE group_id = $1 FOR UPDATE', [groupId]);
    if (unitOf(res.rows[0]?.unit_number) !== unitOf(correction.new_values?.unitNumber)) {
      throw new StaleCorrectionError(`Group ${groupId}'s unit changed since — leaving it alone.`);
    }
    await client.query('UPDATE driver_profiles SET unit_number = $2, updated_at = NOW() WHERE group_id = $1',
      [groupId, correction.old_values?.unitNumber ?? null]);
  },
};

const setTruck = {
  key: 'profile.set_truck',
  tier: 'approval',
  subjectType: 'group',
  describe: (p) => `Record group ${p.groupId}'s truck as ${p.fleet}${p.owner ? ` of ${p.owner}` : ''}`,

  async apply({
    groupId, fleet, owner, fromFleet, fromOwner,
  }, client) {
    if (!groupId || !FLEETS.has(fleet)) throw new StaleCorrectionError('A chat and a truck fleet are both required.');
    const to = normaliseOwner(owner);
    const p = await lockProfile(client, groupId, ['truck_fleet', 'truck_owner', 'truck_source']);
    if ((p.truck_fleet || null) !== (fromFleet || null) || normaliseOwner(p.truck_owner) !== normaliseOwner(fromOwner)) {
      throw new StaleCorrectionError(`Group ${groupId}'s truck changed since the question.`);
    }
    await client.query(
      `UPDATE driver_profiles
          SET truck_fleet = $2, truck_owner = $3, truck_source = 'manual', truck_updated_at = NOW(), updated_at = NOW()
        WHERE group_id = $1`,
      [groupId, fleet, to]
    );
    return {
      oldValues: { truckFleet: p.truck_fleet || null, truckOwner: p.truck_owner || null, truckSource: p.truck_source || null },
      newValues: { truckFleet: fleet, truckOwner: to, truckSource: 'manual' },
      affectedRecords: [{ table: 'driver_profiles', groupId: Number(groupId) }],
    };
  },

  async revert(correction, client) {
    const groupId = Number(correction.subject_id);
    const nv = correction.new_values || {};
    const ov = correction.old_values || {};
    const res = await client.query('SELECT truck_fleet, truck_owner FROM driver_profiles WHERE group_id = $1 FOR UPDATE', [groupId]);
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

module.exports = { setUnit, setTruck };
