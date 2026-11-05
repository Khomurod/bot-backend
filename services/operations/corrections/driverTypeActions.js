/**
 * Record Datatruck's driver type on a Wenze profile — only on a person's Yes.
 *
 *   fleet.set_driver_type   answers `fleet.driver_type_differs_datatruck`
 *
 * APPROVAL ONLY. Datatruck is another system; what it says is a reason to ask,
 * never a write by itself (the owner, 5 November 2026). The tier makes the
 * system unable to apply it (`apply.js` refuses a non-auto action initiated by
 * the system), so this runs only when somebody answers Yes.
 *
 * It changes the DRIVER's type and nothing else. The TRUCK's fleet is the
 * board's (`driver_profiles.truck_fleet`, `identity.truck_from_board`); where
 * the profile records no truck, the driver's type still stands in for it, and
 * `identity.unit_fleet_behind_profile` brings the truck record along on the
 * next sweep — the same path an administrator's edit takes.
 *
 * Re-checked under lock: the profile must still hold the type the question
 * showed. Revertible while it still holds the type this wrote.
 */
const { StaleCorrectionError } = require('./evidence');

const DRIVER_TYPES = new Set(['owner', 'company_driver', 'lease']);

const setDriverType = {
  key: 'fleet.set_driver_type',
  tier: 'approval',
  subjectType: 'group',
  describe: (p) => `Record ${p.to} as group ${p.groupId}'s driver type, as Datatruck says`,

  async apply({ groupId, from, to }, client) {
    if (!groupId || !DRIVER_TYPES.has(to)) throw new StaleCorrectionError('A chat and a driver type Wenze knows are both required.');
    const res = await client.query(
      `SELECT dp.driver_type, g.active, g.group_type
         FROM driver_profiles dp JOIN groups g ON g.id = dp.group_id
        WHERE dp.group_id = $1 FOR UPDATE OF dp`,
      [groupId]
    );
    const p = res.rows[0];
    if (!p || p.active !== true || p.group_type !== 'driver') throw new StaleCorrectionError(`Group ${groupId} is no longer an active driver chat.`);
    if ((p.driver_type || null) !== (from || null)) {
      throw new StaleCorrectionError(`Group ${groupId}'s driver type is now ${p.driver_type || 'not set'}, not ${from || 'not set'}.`);
    }
    if (p.driver_type === to) throw new StaleCorrectionError(`Group ${groupId} already says ${to}.`);
    await client.query('UPDATE driver_profiles SET driver_type = $2, updated_at = NOW() WHERE group_id = $1', [groupId, to]);
    return {
      oldValues: { driverType: p.driver_type || null },
      newValues: { driverType: to },
      affectedRecords: [{ table: 'driver_profiles', groupId: Number(groupId) }],
    };
  },

  async revert(correction, client) {
    const groupId = Number(correction.subject_id);
    const res = await client.query('SELECT driver_type FROM driver_profiles WHERE group_id = $1 FOR UPDATE', [groupId]);
    const now = res.rows[0];
    if (!now || now.driver_type !== correction.new_values?.driverType) {
      throw new StaleCorrectionError(`Group ${groupId}'s driver type changed since — leaving it alone.`);
    }
    await client.query('UPDATE driver_profiles SET driver_type = $2, updated_at = NOW() WHERE group_id = $1',
      [groupId, correction.old_values?.driverType || null]);
  },
};

module.exports = { setDriverType };
