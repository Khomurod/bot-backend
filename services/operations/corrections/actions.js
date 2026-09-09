/**
 * The registry of things the system is allowed to change, and how to undo each.
 *
 * Every action declares BOTH `apply` and `revert`. That pairing is the entry
 * requirement, not a nicety: a correction whose reversal was never written is a
 * correction nobody can safely enable.
 *
 * Two rules bound what can live here.
 *
 *   THE VALUE MUST ALREADY BE RECORDED SOMEWHERE ELSE. Every action copies a
 *   fact this database already holds — a timestamp `driver_home_status` kept, a
 *   state Telegram itself reported. Nothing is inferred, averaged or guessed. An
 *   action that needs judgement does not belong in the registry at all; it
 *   belongs in a finding a human reads.
 *
 *   NOTHING DESTRUCTIVE. Every action here is an UPDATE of a nullable column
 *   whose previous value is captured in full. No action deletes a row. The
 *   `home_time.ghost_home_status` finding, for instance, deliberately has NO
 *   action: retiring that row would destroy the only record of where a driver
 *   was, so it stays a reported finding until someone designs a non-destructive
 *   answer to it.
 *
 * Each `apply` re-reads its target FOR UPDATE and re-checks the precondition
 * inside the caller's transaction. A finding can be minutes old by the time it
 * is applied, and a human may have fixed it by hand in between — in which case
 * the action raises StaleCorrectionError and the batch skips it rather than
 * overwriting the person who got there first.
 */

class StaleCorrectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StaleCorrectionError';
    this.stale = true;
  }
}

/**
 * Close a home-time cycle using the return timestamp already on record.
 *
 * The value comes from `classifyOpenCycles` evidence class A
 * (`driver_home_status.state_since`) or B (the next cycle's `road_started_at`) —
 * never from a calculation. `bonus_usd` is deliberately untouched: it is
 * computed when the row is inserted and closing the cycle does not recompute it,
 * which is what makes this repair payout-neutral.
 */
const closeHomeTimeCycle = {
  key: 'home_time.close_cycle',
  tier: 'auto',
  subjectType: 'road_history',
  describe: (p) => `Close home-time cycle #${p.cycleId} (returned ${p.returnToRoadAt})`,

  async apply({ cycleId, returnToRoadAt, homeDays }, client) {
    const before = await client.query(
      `SELECT id, group_id, return_to_road_at, home_days, bonus_usd
         FROM driver_road_history WHERE id = $1 FOR UPDATE`,
      [cycleId]
    );
    const row = before.rows[0];
    if (!row) throw new StaleCorrectionError(`Cycle ${cycleId} no longer exists.`);
    if (row.return_to_road_at) {
      throw new StaleCorrectionError(`Cycle ${cycleId} was already closed — leaving it alone.`);
    }

    const after = await client.query(
      `UPDATE driver_road_history
          SET return_to_road_at = $2, home_days = $3
        WHERE id = $1 AND return_to_road_at IS NULL
        RETURNING id, group_id, return_to_road_at, home_days, bonus_usd`,
      [cycleId, returnToRoadAt, homeDays ?? null]
    );
    if (!after.rows[0]) throw new StaleCorrectionError(`Cycle ${cycleId} changed under us.`);

    return {
      oldValues: { return_to_road_at: row.return_to_road_at, home_days: row.home_days },
      newValues: {
        return_to_road_at: after.rows[0].return_to_road_at,
        home_days: after.rows[0].home_days,
      },
      affectedRecords: [{ table: 'driver_road_history', id: cycleId, groupId: row.group_id }],
    };
  },

  async revert(correction, client) {
    const cycleId = Number(correction.subject_id);
    await client.query(
      `UPDATE driver_road_history SET return_to_road_at = $2, home_days = $3 WHERE id = $1`,
      [cycleId, correction.old_values.return_to_road_at ?? null, correction.old_values.home_days ?? null]
    );
  },
};

/**
 * Bring `driver_profiles.status` into line with a group state the BOT observed.
 *
 * Only ever proposed when `groups.status_source = 'bot'` — meaning Telegram told
 * us the bot was added or removed, which is as hard as evidence gets here. The
 * same disagreement decided by an LLM is an approval, not an auto.
 *
 * Writes the column directly rather than through `updateDriverProfile`, which
 * stamps `*_source = 'manual'`. Labelling a system correction as a human
 * decision is exactly the bug that already made the AI parser's output
 * indistinguishable from an operator's.
 */
const syncProfileStatus = {
  key: 'identity.sync_profile_status',
  tier: 'auto',
  subjectType: 'group',
  describe: (p) => `Set driver profile status to "${p.toStatus}" for group ${p.groupId}`,

  async apply({ groupId, toStatus }, client) {
    if (toStatus !== 'active' && toStatus !== 'inactive') {
      throw new Error(`Refusing to set an unknown profile status: ${toStatus}`);
    }
    const before = await client.query(
      'SELECT id, group_id, status FROM driver_profiles WHERE group_id = $1 FOR UPDATE',
      [groupId]
    );
    const row = before.rows[0];
    if (!row) throw new StaleCorrectionError(`Group ${groupId} has no driver profile.`);
    if (row.status === toStatus) {
      throw new StaleCorrectionError(`Group ${groupId} already reads "${toStatus}".`);
    }

    // Re-confirm the evidence inside the transaction. The finding said the BOT
    // observed this; if the source has since changed to 'manual', a human has
    // taken ownership and the system must not overrule them.
    const group = await client.query(
      'SELECT active, status_source FROM groups WHERE id = $1',
      [groupId]
    );
    const g = group.rows[0];
    if (!g) throw new StaleCorrectionError(`Group ${groupId} no longer exists.`);
    if (g.status_source !== 'bot') {
      throw new StaleCorrectionError(
        `Group ${groupId} is now sourced from "${g.status_source}", not the bot — not auto-correcting.`
      );
    }
    if ((g.active === true) !== (toStatus === 'active')) {
      throw new StaleCorrectionError(`Group ${groupId} no longer disagrees with its profile.`);
    }

    await client.query(
      'UPDATE driver_profiles SET status = $2, updated_at = NOW() WHERE group_id = $1',
      [groupId, toStatus]
    );

    return {
      oldValues: { status: row.status },
      newValues: { status: toStatus },
      affectedRecords: [{ table: 'driver_profiles', id: row.id, groupId }],
    };
  },

  async revert(correction, client) {
    await client.query(
      'UPDATE driver_profiles SET status = $2, updated_at = NOW() WHERE group_id = $1',
      [Number(correction.subject_id), correction.old_values.status]
    );
  },
};

const ACTIONS = new Map([
  [closeHomeTimeCycle.key, closeHomeTimeCycle],
  [syncProfileStatus.key, syncProfileStatus],
]);

/**
 * Which action answers a given check, if any.
 *
 * A check with no entry is reported and never acted on — the default, and the
 * reason a new check cannot accidentally acquire write access.
 */
const CHECK_TO_ACTION = new Map([
  ['home_time.closable_open_cycle', closeHomeTimeCycle.key],
  ['identity.status_disagreement', syncProfileStatus.key],
]);

function getAction(actionKey) {
  return ACTIONS.get(actionKey) || null;
}

function actionForCheck(checkKey) {
  const key = CHECK_TO_ACTION.get(checkKey);
  return key ? getAction(key) : null;
}

module.exports = {
  StaleCorrectionError,
  ACTIONS,
  CHECK_TO_ACTION,
  getAction,
  actionForCheck,
  closeHomeTimeCycle,
  syncProfileStatus,
};
