/**
 * Setting whether a driver is working — the owner's answer, written to BOTH
 * places that hold it.
 *
 *   identity.set_driver_status   `groups.active` and `driver_profiles.status`
 *                                set together to the value a person chose.
 *
 * WHY THIS EXISTS BESIDE `identity.sync_profile_status`. That action copies a
 * state the BOT observed onto the profile, and it refuses — correctly — when
 * the group's state came from an AI reading or an admin, because then nothing
 * observed it. Production, 2026-10-07: the owner answered "Yes" to a status
 * question whose group had been set by the AI, the sync refused, and Wenze
 * replied "Somebody fixed it first — nothing left to change." Nobody had. The
 * owner's answer was simply not something that action could carry.
 *
 * A person's answer is evidence of a different kind: it is not copying a
 * recorded fact, it is a decision. So it gets its own action, APPROVAL TIER —
 * only ever applied by a person — and it writes the decision as one:
 * `status_source = 'manual'`, which is also what stops the AI classifier
 * overruling it on its next pass (`getDriverGroupsForStatusAi` skips manual).
 *
 * Revert restores the before-image only while both rows still hold what this
 * correction set, the same rule every action in the registry follows.
 */
const { StaleCorrectionError } = require('./evidence');

const STATUSES = new Set(['active', 'inactive']);

const setDriverStatus = {
  key: 'identity.set_driver_status',
  tier: 'approval',
  subjectType: 'group',
  describe: (p) => `Set driver in group ${p.groupId} to "${p.toStatus}"`,

  async apply({ groupId, toStatus }, client) {
    if (!groupId) throw new StaleCorrectionError('A group is required.');
    if (!STATUSES.has(toStatus)) {
      throw new Error(`Refusing to set an unknown driver status: ${toStatus}`);
    }
    const toActive = toStatus === 'active';

    // Group first, then profile — the order every other writer takes them in.
    const g = (await client.query(
      `SELECT id, group_type, active, status_source, status_updated_at
         FROM groups WHERE id = $1 FOR UPDATE`,
      [groupId]
    )).rows[0];
    if (!g) throw new StaleCorrectionError(`Group ${groupId} no longer exists.`);
    if (g.group_type !== 'driver') {
      throw new StaleCorrectionError(`Group ${groupId} is no longer a driver group.`);
    }
    const p = (await client.query(
      'SELECT id, status FROM driver_profiles WHERE group_id = $1 FOR UPDATE',
      [groupId]
    )).rows[0] || null;

    const groupAlready = (g.active === true) === toActive;
    const profileAlready = !p || p.status === toStatus;
    if (groupAlready && profileAlready) {
      const err = new StaleCorrectionError(`Group ${groupId} already reads "${toStatus}" everywhere.`);
      err.plain = `Nothing to change — it already shows ${toActive ? 'working' : 'not working'} everywhere.`;
      throw err;
    }

    await client.query(
      `UPDATE groups SET active = $2, status_source = 'manual', status_updated_at = NOW()
        WHERE id = $1`,
      [groupId, toActive]
    );
    if (p && p.status !== toStatus) {
      await client.query(
        'UPDATE driver_profiles SET status = $2, updated_at = NOW() WHERE group_id = $1',
        [groupId, toStatus]
      );
    }

    return {
      oldValues: {
        groupActive: g.active,
        statusSource: g.status_source,
        statusUpdatedAt: g.status_updated_at,
        profileStatus: p ? p.status : null,
      },
      newValues: {
        groupId,
        groupActive: toActive,
        statusSource: 'manual',
        profileStatus: p ? toStatus : null,
      },
      affectedRecords: [
        { table: 'groups', id: groupId },
        ...(p ? [{ table: 'driver_profiles', id: p.id, groupId }] : []),
      ],
    };
  },

  async revert(correction, client) {
    const groupId = Number(correction.new_values?.groupId || correction.subject_id);
    const nv = correction.new_values || {};
    const ov = correction.old_values || {};
    const g = (await client.query(
      'SELECT active, status_source FROM groups WHERE id = $1 FOR UPDATE',
      [groupId]
    )).rows[0];
    if (!g) throw new StaleCorrectionError(`Group ${groupId} no longer exists.`);
    if (g.active !== nv.groupActive || g.status_source !== nv.statusSource) {
      throw new StaleCorrectionError(`Group ${groupId}'s status changed since — leaving it alone.`);
    }
    const p = (await client.query(
      'SELECT status FROM driver_profiles WHERE group_id = $1 FOR UPDATE',
      [groupId]
    )).rows[0] || null;
    if (nv.profileStatus != null && (!p || p.status !== nv.profileStatus)) {
      throw new StaleCorrectionError(`Group ${groupId}'s profile changed since — leaving it alone.`);
    }

    await client.query(
      'UPDATE groups SET active = $2, status_source = $3, status_updated_at = $4 WHERE id = $1',
      [groupId, ov.groupActive, ov.statusSource ?? null, ov.statusUpdatedAt ?? null]
    );
    if (nv.profileStatus != null && ov.profileStatus != null) {
      await client.query(
        'UPDATE driver_profiles SET status = $2, updated_at = NOW() WHERE group_id = $1',
        [groupId, ov.profileStatus]
      );
    }
  },
};

/** The checks whose question is answered with a status value. */
const STATUS_CHECKS = new Set(['identity.status_disagreement', 'identity.status_needs_decision']);

/**
 * How an owner's chosen value becomes a change, for a check whose question
 * offers values rather than yes/no. Null for every other check.
 */
function choiceActionFor(checkKey) {
  if (!STATUS_CHECKS.has(checkKey)) return null;
  return {
    action: setDriverStatus,
    payload(finding, value) {
      const groupId = finding?.proposedChange?.groupId ?? finding?.evidence?.groupId ?? null;
      return groupId && STATUSES.has(value) ? { groupId, toStatus: value } : null;
    },
  };
}

module.exports = { setDriverStatus, choiceActionFor };
