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
 *
 * EXCEPT THE PERSON THE LAYER MADE UP FROM THE CHAT'S OWN NAME. On 10 September
 * 2026 the person layer gave every driver-typed chat a person, and an office
 * chat got one named after itself: "HR Personnel", "Employee Feedback",
 * "Wenze Facebook Leads". That is not a driver placed there — it is the chat's
 * title again — and it made all seven office chats impossible to retype: the
 * owner's "yes" of 20 October 2026 was refused by this very guard. A person
 * counts as such a placeholder only when the bot created it, its name IS the
 * chat's name, and it has nothing else: no other chat, no truck, no Telegram
 * account. Then its association is ended (stamped, never deleted) in the same
 * transaction, and the revert reopens it.
 */
const { StaleCorrectionError } = require('./evidence');
const { normalizePersonName } = require('../../../lib/drivers/driverGroupTitle');

/**
 * The names the person layer could have made up from a chat's title: the
 * whole title, or the title without its trailing "(Admin)". PURE.
 *
 * NOT the driver name parsed out of a "WENZE UNIT # 001 STARKS DAYMON" title —
 * that is a real driver's name, and a driver is never a placeholder.
 */
function placeholderNamesFor(groupName) {
  const raw = String(groupName || '');
  return new Set([raw, raw.replace(/\s*\([^)]*\)\s*$/, '')]
    .map(normalizePersonName)
    .filter(Boolean));
}

/** The chat's open association, and whether it is only the chat's own name. */
async function openAssociation(groupId, groupName, client) {
  const res = await client.query(
    `SELECT pg.id, pg.person_id, p.display_name, p.created_source,
            (SELECT COUNT(*) FROM driver_person_groups o
              WHERE o.person_id = pg.person_id AND o.id <> pg.id)::int AS other_groups,
            (SELECT COUNT(*) FROM driver_units u WHERE u.person_id = pg.person_id)::int AS units,
            (SELECT COUNT(*) FROM driver_person_telegram_identities t
              WHERE t.person_id = pg.person_id)::int AS accounts
       FROM driver_person_groups pg
       JOIN driver_people p ON p.id = pg.person_id
      WHERE pg.group_id = $1 AND pg.ended_at IS NULL
        FOR UPDATE OF pg`,
    [groupId]
  );
  const open = res.rows[0] || null;
  const placeholder = Boolean(open)
    && open.created_source === 'bot'
    && open.other_groups === 0 && open.units === 0 && open.accounts === 0
    && placeholderNamesFor(groupName).has(normalizePersonName(open.display_name));
  return { open, placeholder };
}

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
    const { open, placeholder } = await openAssociation(groupId, group.group_name, client);
    if (open && !placeholder) {
      throw new StaleCorrectionError(
        `Group ${groupId} has driver ${open.person_id} placed in it — that is not an admin chat.`
      );
    }
    if (placeholder) {
      await client.query('UPDATE driver_person_groups SET ended_at = NOW() WHERE id = $1', [open.id]);
    }
    const endedPlaceholder = placeholder
      ? { associationId: open.id, personId: open.person_id, personName: open.display_name }
      : null;

    await client.query(
      // NO updated_at: the groups table does not have one. A column that does
      // not exist raises at apply time, inside the transaction, for every
      // retype — which is what this looked like before the Pg suite ran.
      'UPDATE groups SET group_type = $2 WHERE id = $1',
      [groupId, toType]
    );

    return {
      oldValues: { groupType: 'driver', groupName: group.group_name },
      newValues: { groupType: toType, groupId, endedPlaceholder },
      affectedRecords: [
        { table: 'groups', id: groupId },
        ...(endedPlaceholder ? [{ table: 'driver_person_groups', id: endedPlaceholder.associationId }] : []),
      ],
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
    // The placeholder comes back with the type — unless the chat has since been
    // given a real person, who must not be joined by its own title.
    const ended = correction.new_values?.endedPlaceholder;
    if (ended?.associationId) {
      await client.query(
        `UPDATE driver_person_groups SET ended_at = NULL
          WHERE id = $1 AND ended_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM driver_person_groups o
                             WHERE o.group_id = $2 AND o.ended_at IS NULL)`,
        [ended.associationId, groupId]
      );
    }
  },
};

module.exports = { setGroupType, placeholderNamesFor };
