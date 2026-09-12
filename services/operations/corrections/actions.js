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
 * Each `apply` locks its target AND its evidence FOR UPDATE and re-derives the
 * answer inside the caller's transaction, rather than trusting the payload the
 * sweep computed. A finding can be hours old by the time it is applied, and a
 * person may have edited the rows it was built from in between — the target
 * column, or the arrival time its duration was measured from, or the observed
 * transition its timestamp was copied out of. When the re-derived answer differs
 * from the proposal, the action raises StaleCorrectionError and the batch skips
 * it. Being second to a person is a success, not an error.
 *
 * Each `revert` does the same in reverse: it restores the before-image ONLY
 * while the fields it changed still hold what it set them to. An unconditional
 * restore would silently destroy an edit made after the correction landed.
 */
const {
  StaleCorrectionError, sameInstant, assertUnchangedSince,
} = require('./evidence');
const { abandonExhaustedInternalAlerts } = require('./alertActions');
const { ensurePerson, syncUnit } = require('./identityActions');
const { linkBoardRowToPerson } = require('./boardActions');
const { setGroupType } = require('./groupActions');
const { linkTelegramIdentity } = require('./telegramActions');
const { carryRoadClock } = require('./homeTimeActions');
const { markReturnedToRoad } = require('./returnToRoadActions');
const { classifyOpenCycles, daysBetween } = require('../checks/homeTime');

/** ±days around the home arrival, matching `findDecidedRequestNearDate`. */
const REQUEST_LINK_WINDOW_DAYS = 3;

function isoDay(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * The decided home-time request that authorized this stay — or nothing.
 *
 * `closeHomeStayOnReturn` fills this on the normal path for a concrete reason:
 * `homeTimeEfficiencyService.classifyCycle` reads `linked_request_status` and,
 * without it, files an over-policy stay a human APPROVED as `non_compliant`. A
 * repair that closed cycles and left the column null would therefore not be
 * payout-neutral at all — it would quietly make the efficiency dashboard wrong
 * about exactly the drivers who did nothing wrong.
 *
 * So the link is resolved here too, with one deliberate difference from the live
 * path: that one takes the nearest match, this one requires the match to be
 * UNAMBIGUOUS. Two decided requests inside a 7-day window is a judgement call
 * about which one authorized the stay, and the rule at the top of this file says
 * a judgement call is not something the registry gets to make. It stands down
 * instead, and the cycle stays open for a person to close.
 */
async function resolveLinkedRequest(client, groupId, homeArrivedAt) {
  const day = isoDay(homeArrivedAt);
  if (!day) return { id: null, candidates: 0 };
  const res = await client.query(
    `SELECT id FROM home_time_requests
      WHERE group_id = $1
        AND status IN ('recorded', 'pending', 'approved', 'denied')
        AND home_from IS NOT NULL
        AND ABS(home_from - $2::date) <= $3`,
    [groupId, day, REQUEST_LINK_WINDOW_DAYS]
  );
  if (res.rows.length === 1) return { id: res.rows[0].id, candidates: 1 };
  return { id: null, candidates: res.rows.length };
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
    // Lock every cycle of this group, not just the target: class B evidence
    // lives in a SIBLING row, so locking the target alone would leave the proof
    // free to move while the correction runs.
    const cycles = await client.query(
      `SELECT id, group_id, road_started_at, home_arrived_at, return_to_road_at,
              home_days, bonus_usd, linked_request_id
         FROM driver_road_history
        WHERE group_id = (SELECT group_id FROM driver_road_history WHERE id = $1)
        ORDER BY id
          FOR UPDATE`,
      [cycleId]
    );
    const row = cycles.rows.find((r) => r.id === cycleId);
    if (!row) throw new StaleCorrectionError(`Cycle ${cycleId} no longer exists.`);
    if (row.return_to_road_at) {
      throw new StaleCorrectionError(`Cycle ${cycleId} was already closed — leaving it alone.`);
    }

    // Class A evidence. Locked for the same reason.
    const statusRes = await client.query(
      'SELECT group_id, state, state_since FROM driver_home_status WHERE group_id = $1 FOR UPDATE',
      [row.group_id]
    );

    // Re-derive from the rows AS THEY ARE NOW, through the same function the
    // check used. If an admin has since edited `home_arrived_at`, or moved the
    // observed transition, this disagrees with the proposal and nothing is
    // written.
    const verdict = classifyOpenCycles({
      roadHistory: cycles.rows, homeStatus: statusRes.rows,
    }).find((v) => v.cycle.id === cycleId);

    if (!verdict || (verdict.evidenceClass !== 'A' && verdict.evidenceClass !== 'B')) {
      throw new StaleCorrectionError(
        `Cycle ${cycleId} no longer has closable evidence `
        + `(now class ${verdict ? verdict.evidenceClass : 'none'}) — leaving it open.`
      );
    }
    if (!sameInstant(verdict.returnAt, returnToRoadAt)) {
      throw new StaleCorrectionError(
        `Cycle ${cycleId}: the recorded return moment has moved since this was proposed `
        + `— leaving it open.`
      );
    }
    const days = daysBetween(row.home_arrived_at, verdict.returnAt);
    if (homeDays != null && Number(homeDays) !== days) {
      throw new StaleCorrectionError(
        `Cycle ${cycleId}: the home stay is now ${days} days, not ${homeDays} — leaving it open.`
      );
    }

    // The authorization link, without which this repair would corrupt the
    // efficiency dashboard. See resolveLinkedRequest.
    let linkedRequestId = row.linked_request_id ?? null;
    if (linkedRequestId == null) {
      const link = await resolveLinkedRequest(client, row.group_id, row.home_arrived_at);
      if (link.candidates > 1) {
        throw new StaleCorrectionError(
          `Cycle ${cycleId}: ${link.candidates} decided home-time requests match this stay, so which `
          + `one authorized it is a judgement call — leaving it for a person.`
        );
      }
      linkedRequestId = link.id;
    }

    const after = await client.query(
      `UPDATE driver_road_history
          SET return_to_road_at = $2, home_days = $3, linked_request_id = $4
        WHERE id = $1 AND return_to_road_at IS NULL
        RETURNING id, group_id, return_to_road_at, home_days, linked_request_id, bonus_usd`,
      [cycleId, verdict.returnAt, days, linkedRequestId]
    );
    if (!after.rows[0]) throw new StaleCorrectionError(`Cycle ${cycleId} changed under us.`);

    return {
      oldValues: {
        return_to_road_at: row.return_to_road_at,
        home_days: row.home_days,
        linked_request_id: row.linked_request_id ?? null,
      },
      newValues: {
        return_to_road_at: after.rows[0].return_to_road_at,
        home_days: after.rows[0].home_days,
        linked_request_id: after.rows[0].linked_request_id ?? null,
      },
      affectedRecords: [{ table: 'driver_road_history', id: cycleId, groupId: row.group_id }],
    };
  },

  async revert(correction, client) {
    const cycleId = Number(correction.subject_id);
    const current = await client.query(
      `SELECT return_to_road_at, home_days, linked_request_id
         FROM driver_road_history WHERE id = $1 FOR UPDATE`,
      [cycleId]
    );
    if (!current.rows[0]) throw new StaleCorrectionError(`Cycle ${cycleId} no longer exists.`);
    assertUnchangedSince(correction.new_values, current.rows[0], `Cycle ${cycleId}`);

    // Restore the link only if THIS correction recorded one. A correction
    // written before the column was part of the before-image says nothing about
    // what it held, and `?? null` would turn that silence into a deletion.
    const restoresLink = Object.prototype.hasOwnProperty.call(
      correction.old_values || {}, 'linked_request_id'
    );
    await client.query(
      `UPDATE driver_road_history
          SET return_to_road_at = $2,
              home_days = $3,
              linked_request_id = CASE WHEN $5::boolean THEN $4::int ELSE linked_request_id END
        WHERE id = $1`,
      [
        cycleId,
        correction.old_values.return_to_road_at ?? null,
        correction.old_values.home_days ?? null,
        correction.old_values.linked_request_id ?? null,
        restoresLink,
      ]
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

    // Group first, then profile — parent before child, the order the rest of the
    // application reads them in, so two writers queue rather than deadlock.
    //
    // FOR UPDATE, not a plain SELECT: this row IS the evidence. Reading it
    // unlocked would let an operator take ownership of the status in the window
    // between the check below and the commit, and the system would overrule them
    // anyway — the precise thing the check exists to prevent.
    const group = await client.query(
      'SELECT id, active, status_source FROM groups WHERE id = $1 FOR UPDATE',
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

    const before = await client.query(
      'SELECT id, group_id, status FROM driver_profiles WHERE group_id = $1 FOR UPDATE',
      [groupId]
    );
    const row = before.rows[0];
    if (!row) throw new StaleCorrectionError(`Group ${groupId} has no driver profile.`);
    if (row.status === toStatus) {
      throw new StaleCorrectionError(`Group ${groupId} already reads "${toStatus}".`);
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
    const groupId = Number(correction.subject_id);
    const current = await client.query(
      'SELECT status FROM driver_profiles WHERE group_id = $1 FOR UPDATE',
      [groupId]
    );
    if (!current.rows[0]) throw new StaleCorrectionError(`Group ${groupId} has no driver profile.`);
    assertUnchangedSince(correction.new_values, current.rows[0], `Group ${groupId}'s profile`);

    await client.query(
      'UPDATE driver_profiles SET status = $2, updated_at = NOW() WHERE group_id = $1',
      [groupId, correction.old_values.status]
    );
  },
};

const ACTIONS = new Map([
  [closeHomeTimeCycle.key, closeHomeTimeCycle],
  [syncProfileStatus.key, syncProfileStatus],
  [abandonExhaustedInternalAlerts.key, abandonExhaustedInternalAlerts],
  [linkBoardRowToPerson.key, linkBoardRowToPerson],
  [setGroupType.key, setGroupType],
  [linkTelegramIdentity.key, linkTelegramIdentity],
  [ensurePerson.key, ensurePerson],
  [syncUnit.key, syncUnit],
  [carryRoadClock.key, carryRoadClock],
  [markReturnedToRoad.key, markReturnedToRoad],
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
  ['home_time.exhausted_internal_alerts', abandonExhaustedInternalAlerts.key],
  ['identity.group_without_person', ensurePerson.key],
  ['identity.stale_unit_assignment', syncUnit.key],
  ['home_time.clock_reset_on_group_change', carryRoadClock.key],
  ['home_time.returned_to_road', markReturnedToRoad.key],
  ['identity.non_driver_typed_as_driver', setGroupType.key],
  ['identity.telegram_link', linkTelegramIdentity.key],
  ['identity.telegram_member_unnamed', linkTelegramIdentity.key],
  ['board.person_link', linkBoardRowToPerson.key],
  ['board.person_link_suggested', linkBoardRowToPerson.key],
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
  REQUEST_LINK_WINDOW_DAYS,
  ACTIONS,
  CHECK_TO_ACTION,
  getAction,
  actionForCheck,
  resolveLinkedRequest,
  closeHomeTimeCycle,
  syncProfileStatus,
};
