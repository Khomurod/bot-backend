/**
 * Retyping a chat that was never a driver's.
 *
 *   identity.set_group_type   a chat typed `driver` that is plainly an admin or
 *                             utility room becomes `company`.
 *
 * APPROVAL TIER, AND ONLY EVER APPLIED BY A PERSON. The check that proposes it
 * reads a TITLE — "Employee Feedback (Admin)", "HR Personnel" — at 65
 * confidence, which is a guess about what a room is for. Guesses do not get to
 * act, and this one has consequences a person must see first:
 *
 *   BOL and POD documents stop routing to that chat.
 *   It stops receiving broadcasts.
 *   Its driver profile stops being indexed as a driver.
 *
 * Those are the right outcomes for a genuine admin room and wrong ones for a
 * driver whose chat happens to be named unusually, so the finding's evidence
 * spells them out and a human clicks.
 *
 * THE TWO REFUSALS. It will not retype a chat that is no longer `driver` (the
 * question was already settled), and it will not retype one with an OPEN PERSON
 * ASSOCIATION — the person layer having placed a driver there is the strongest
 * evidence available that it is a driver's chat, and it outranks a title regex.
 */
const { StaleCorrectionError } = require('./evidence');
const people = require('../../../database/driverPeople');

const setGroupType = {
  key: 'identity.set_group_type',
  tier: 'approval',
  subjectType: 'group',
  describe: (p) => `Retype chat ${p.groupId} from driver to ${p.toType || 'company'}`,

  async apply({ groupId, toType = 'company' }, client) {
    if (!groupId) throw new StaleCorrectionError('A group is required.');
    if (toType !== 'company') {
      throw new StaleCorrectionError(`This correction only retypes to "company", not "${toType}".`);
    }

    const res = await client.query(
      'SELECT id, group_name, group_type, active FROM groups WHERE id = $1 FOR UPDATE',
      [groupId]
    );
    const group = res.rows[0];
    if (!group) throw new StaleCorrectionError(`Group ${groupId} no longer exists.`);
    if (group.group_type !== 'driver') {
      throw new StaleCorrectionError(`Group ${groupId} is already typed "${group.group_type}".`);
    }

    // THE PERSON LAYER OUTRANKS A TITLE. If a driver is placed here, this is a
    // driver's chat whatever the name reads like.
    const open = await people.getOpenAssociationForGroup(groupId, client);
    if (open) {
      throw new StaleCorrectionError(
        `Group ${groupId} has driver ${open.personId} placed in it — that is not an admin chat.`
      );
    }

    await client.query(
      // NO updated_at: the groups table does not have one. A column that does
      // not exist raises at apply time, inside the transaction, for every
      // retype — which is what this looked like before the Pg suite ran.
      'UPDATE groups SET group_type = $2 WHERE id = $1',
      [groupId, toType]
    );

    return {
      oldValues: { groupType: 'driver', groupName: group.group_name },
      newValues: { groupType: toType, groupId },
      affectedRecords: [{ table: 'groups', id: groupId }],
    };
  },

  /** Back to `driver`, but only while it still holds what this correction set. */
  async revert(correction, client) {
    const groupId = Number(correction.new_values?.groupId || correction.subject_id);
    const restored = await client.query(
      `UPDATE groups SET group_type = $2
        WHERE id = $1 AND group_type = $3
        RETURNING id`,
      [groupId, correction.old_values?.groupType || 'driver', correction.new_values?.groupType || 'company']
    );
    if (restored.rowCount === 0) {
      throw new StaleCorrectionError(
        `Group ${groupId} is no longer typed "${correction.new_values?.groupType}" — leaving it alone.`
      );
    }
  },
};

module.exports = { setGroupType };
