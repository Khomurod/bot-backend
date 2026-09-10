/**
 * The one correction that says "this driver went back to work".
 *
 * It is the only action in the registry that moves a driver's live state on
 * evidence gathered from OUTSIDE the chat — a Datatruck load plus the truck's
 * own movement — so it re-derives the harder half of that evidence at apply
 * time and refuses on anything that has moved. Three separate things must
 * still be true when it runs, and each of them is a real way for this to be
 * wrong by the time a batch reaches it:
 *
 *   the driver must still be marked home        (someone may have flipped them)
 *   the watch must still read HIGH, recently    (the truck may have turned back)
 *   the cycle must still be open                (a person may have closed it)
 *
 * The manager notice is enqueued INSIDE this transaction rather than sent after
 * it. A notice is a database row in an outbox, so a rolled-back correction
 * cannot leave three managers told about a return that did not happen — and a
 * committed one cannot be silent because Telegram happened to be down.
 */
const { DateTime } = require('luxon');
const { StaleCorrectionError, assertUnchangedSince } = require('./evidence');
const { eventKeyFor, buildBackOnRoadNotice } = require('../../../lib/homeTime/managerNotice');
const { HOME_TIME_MANAGER_MENTIONS } = require('../../homeTimeRequestConstants');

/** A verdict older than this is not evidence about now. */
const MAX_VERDICT_AGE_MINUTES = 90;
const REQUEST_LINK_WINDOW_DAYS = 3;

function wholeDays(fromIso, toIso) {
  const a = DateTime.fromJSDate(new Date(fromIso));
  const b = DateTime.fromJSDate(new Date(toIso));
  if (!a.isValid || !b.isValid) return null;
  return Math.max(0, Math.floor(b.diff(a, 'days').days));
}

function minutesSince(iso, nowMs = Date.now()) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (nowMs - t) / 60000 : Infinity;
}

/** The request behind this stay, when exactly one matches. Ambiguity links nothing. */
async function resolveLinkedRequest(client, groupId, homeArrivedAt) {
  const day = homeArrivedAt ? DateTime.fromJSDate(new Date(homeArrivedAt)).toISODate() : null;
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

const markReturnedToRoad = {
  key: 'home_time.mark_returned_to_road',
  tier: 'auto',
  subjectType: 'group',
  describe: (p) => `Mark the driver of group ${p.groupId} back on the road (${p.returnToRoadAt})`,

  async apply({ groupId, returnToRoadAt, evidenceSummary = null }, client) {
    // The live state IS the evidence for "they were home", so it is locked.
    const statusRes = await client.query(
      `SELECT group_id, state, state_since, telegram_group_id
         FROM driver_home_status WHERE group_id = $1 FOR UPDATE`,
      [groupId]
    );
    const status = statusRes.rows[0];
    if (!status) throw new StaleCorrectionError(`Group ${groupId} has no home/road state.`);
    if (status.state !== 'home') {
      throw new StaleCorrectionError(
        `Group ${groupId} is already '${status.state}' — someone was here first.`
      );
    }

    // Re-read the verdict rather than trusting the payload, and refuse a stale
    // one: a truck that drove out and came back must not be reported as gone.
    const watchRes = await client.query(
      `SELECT * FROM home_time_return_watch WHERE group_id = $1 FOR UPDATE`,
      [groupId]
    );
    const watch = watchRes.rows[0];
    if (!watch) throw new StaleCorrectionError(`Group ${groupId} is no longer being watched.`);
    if (watch.last_confidence !== 'high') {
      throw new StaleCorrectionError(
        `Group ${groupId}: the evidence now reads '${watch.last_confidence || 'none'}', not high.`
      );
    }
    if (minutesSince(watch.last_checked_at) > MAX_VERDICT_AGE_MINUTES) {
      throw new StaleCorrectionError(
        `Group ${groupId}: the last look at this truck is over ${MAX_VERDICT_AGE_MINUTES} minutes old.`
      );
    }

    const eventAt = returnToRoadAt || watch.last_seen_at || new Date().toISOString();

    // Close the open cycle, if there is one. A driver first observed at home has
    // no cycle to close, and that is not a reason to refuse the state change.
    const cycleRes = await client.query(
      `SELECT id, home_arrived_at, return_to_road_at, home_days, linked_request_id
         FROM driver_road_history
        WHERE group_id = $1 AND return_to_road_at IS NULL
        ORDER BY home_arrived_at DESC
          FOR UPDATE`,
      [groupId]
    );
    const cycle = cycleRes.rows[0] || null;
    let closed = null;
    if (cycle) {
      const days = wholeDays(cycle.home_arrived_at, eventAt);
      let linkedRequestId = cycle.linked_request_id ?? null;
      if (linkedRequestId == null) {
        const link = await resolveLinkedRequest(client, groupId, cycle.home_arrived_at);
        linkedRequestId = link.candidates === 1 ? link.id : null;
      }
      const after = await client.query(
        `UPDATE driver_road_history
            SET return_to_road_at = $2, home_days = $3, linked_request_id = COALESCE($4, linked_request_id)
          WHERE id = $1 AND return_to_road_at IS NULL
          RETURNING id, return_to_road_at, home_days, linked_request_id`,
        [cycle.id, eventAt, days, linkedRequestId]
      );
      if (!after.rows[0]) throw new StaleCorrectionError(`Cycle ${cycle.id} changed under us.`);
      closed = after.rows[0];
    }

    // The state itself. `road_bonus_weeks_notified` resets because a new road
    // leg starts here, exactly as the message-driven transition does.
    await client.query(
      `UPDATE driver_home_status
          SET state = 'road', state_since = $2, road_bonus_weeks_notified = 0,
              last_status_at = $2
        WHERE group_id = $1 AND state = 'home'`,
      [groupId, eventAt]
    );

    // The watch is over.
    await client.query('DELETE FROM home_time_return_watch WHERE group_id = $1', [groupId]);

    await enqueueBackOnRoadNotice(client, {
      groupId, cycleId: closed?.id || null, personId: watch.person_id,
      eventAt, homeDays: closed?.home_days ?? null,
      evidenceSummary: evidenceSummary || describeWatch(watch),
    });

    return {
      oldValues: {
        state: 'home',
        state_since: status.state_since,
        return_to_road_at: cycle ? cycle.return_to_road_at : undefined,
        home_days: cycle ? cycle.home_days : undefined,
        linked_request_id: cycle ? (cycle.linked_request_id ?? null) : undefined,
        cycle_id: cycle ? cycle.id : null,
      },
      newValues: {
        state: 'road',
        state_since: eventAt,
        return_to_road_at: closed ? closed.return_to_road_at : undefined,
        home_days: closed ? closed.home_days : undefined,
        linked_request_id: closed ? (closed.linked_request_id ?? null) : undefined,
      },
      affectedRecords: [
        { table: 'driver_home_status', groupId, personId: watch.person_id || null },
        ...(closed ? [{ table: 'driver_road_history', id: closed.id, groupId }] : []),
      ],
    };
  },

  /**
   * Put the driver back home and re-open the cycle — but only while the state
   * still holds what this correction set. An admin who has since moved the
   * driver again owns that decision; overwriting it would be the second
   * mistake. The notice already sent is history and stays.
   */
  async revert(correction, client) {
    const groupId = Number(correction.subject_id);
    const current = await client.query(
      'SELECT state, state_since FROM driver_home_status WHERE group_id = $1 FOR UPDATE',
      [groupId]
    );
    if (!current.rows[0]) throw new StaleCorrectionError(`Group ${groupId} has no home/road state.`);
    assertUnchangedSince(
      { state: correction.new_values.state, state_since: correction.new_values.state_since },
      current.rows[0],
      `Group ${groupId}`
    );

    await client.query(
      `UPDATE driver_home_status
          SET state = $2, state_since = $3, road_bonus_weeks_notified = 0
        WHERE group_id = $1`,
      [groupId, correction.old_values.state || 'home', correction.old_values.state_since]
    );

    const cycleId = correction.old_values.cycle_id;
    if (cycleId) {
      const cycle = await client.query(
        'SELECT return_to_road_at, home_days, linked_request_id FROM driver_road_history WHERE id = $1 FOR UPDATE',
        [cycleId]
      );
      if (cycle.rows[0]) {
        assertUnchangedSince(
          {
            return_to_road_at: correction.new_values.return_to_road_at,
            home_days: correction.new_values.home_days,
          },
          cycle.rows[0],
          `Cycle ${cycleId}`
        );
        await client.query(
          `UPDATE driver_road_history
              SET return_to_road_at = $2, home_days = $3, linked_request_id = $4
            WHERE id = $1`,
          [
            cycleId,
            correction.old_values.return_to_road_at ?? null,
            correction.old_values.home_days ?? null,
            correction.old_values.linked_request_id ?? null,
          ]
        );
      }
    }
  },
};

/** One phrase from the stored watch, when the caller did not supply one. */
function describeWatch(watch) {
  const parts = [];
  if (watch.load_status) parts.push(`load ${watch.load_status}`);
  else if (watch.load_identifier) parts.push('active load');
  if (Number(watch.max_miles_from_anchor) > 0) {
    parts.push(`truck ${Math.round(Number(watch.max_miles_from_anchor))} mi from home`);
  }
  if (watch.moving_sightings > 1) parts.push('movement confirmed');
  return parts.join(' + ') || 'load and truck activity';
}

/**
 * The notice, written into the outbox in the correction's own transaction, so
 * it commits with the state change or not at all.
 */
async function enqueueBackOnRoadNotice(client, {
  groupId, cycleId, personId, eventAt, homeDays, evidenceSummary,
}) {
  const settings = await client.query(
    'SELECT completed_notify_group_id FROM home_time_settings WHERE id = 1'
  );
  const chatId = settings.rows[0]?.completed_notify_group_id;
  if (!chatId) return null;

  const who = await client.query(
    `SELECT g.group_name, p.first_name, p.last_name, p.unit_number
       FROM groups g LEFT JOIN driver_profiles p ON p.group_id = g.id
      WHERE g.id = $1`,
    [groupId]
  );
  const row = who.rows[0] || {};
  const driverName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim()
    || row.group_name || `Group ${groupId}`;

  const body = buildBackOnRoadNotice({
    driverName,
    unitNumber: row.unit_number || null,
    endedAt: eventAt,
    homeDays,
    evidence: evidenceSummary,
    mentions: HOME_TIME_MANAGER_MENTIONS,
  });
  const subject = cycleId || `${groupId}:${eventAt}`;
  const res = await client.query(
    `INSERT INTO home_time_manager_notices
       (event_key, event_type, person_id, group_id, road_history_id, chat_id, body, evidence_json)
     VALUES ($1, 'back_on_road', $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id`,
    [
      eventKeyFor('back_on_road', subject), personId || null, groupId, cycleId || null,
      String(chatId), body,
      JSON.stringify({ endedAt: eventAt, homeDays, detectedBy: 'return_watch', summary: evidenceSummary }),
    ]
  );
  return res.rows[0]?.id || null;
}

module.exports = {
  MAX_VERDICT_AGE_MINUTES,
  markReturnedToRoad,
  resolveLinkedRequest,
  describeWatch,
  enqueueBackOnRoadNotice,
  wholeDays,
};
