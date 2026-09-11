'use strict';

/**
 * The facts a retention assessment is built from, and the assessment itself.
 *
 * Two halves, and they are separate on purpose. `gatherRetentionInputs` READS —
 * from eight tables that were each written for another feature — and produces
 * one plain object per driver. `lib/retention/signals.js` then decides, with no
 * database anywhere near it. Nothing in this file knows what a "risk" is.
 *
 * THE 30-DAY CEILING IS NOT A CHOICE. `chat_logs` is pruned hourly at 30 days
 * (`services/schedulerService.js`), so every signal drawn from what a driver
 * SAID is bounded by that. A longer window would not find older messages; it
 * would find none, and report a driver who has been complaining for two months
 * as one who has gone quiet. The queries below say 30 days because the data
 * says 30 days.
 */
const { query } = require('./pool');

const WINDOW_DAYS = 30;

/**
 * One row per active driver chat, carrying everything the pure scorer needs.
 *
 * Written as ONE query with subselects rather than nine round trips: the fleet
 * is a few hundred rows and the sweep runs every fifteen minutes, so the cost
 * that matters is the number of trips, not the width of the row.
 */
async function gatherRetentionInputs({ windowDays = WINDOW_DAYS } = {}) {
  const days = Math.min(Math.max(Number(windowDays) || WINDOW_DAYS, 1), WINDOW_DAYS);

  const res = await query(
    `WITH allowance AS (
       SELECT COALESCE(road_allowance_weeks, 4) AS weeks FROM home_time_settings WHERE id = 1
     ),
     driver AS (
       SELECT g.id AS group_id, g.group_name, g.last_message_seen_at,
              s.person_id, s.state, s.state_since,
              dp.first_name, dp.last_name, dp.driver_type
         FROM groups g
         LEFT JOIN driver_home_status s ON s.group_id = g.id
         LEFT JOIN driver_profiles dp ON dp.group_id = g.id
        WHERE g.group_type = 'driver' AND g.active = TRUE
     )
     SELECT d.group_id,
            d.person_id,
            d.group_name,
            TRIM(CONCAT_WS(' ', d.first_name, d.last_name)) AS driver_name,
            d.driver_type,
            d.state,
            d.state_since,
            (SELECT weeks FROM allowance) AS road_allowance_weeks,

            -- What the driver said. Joined through chat_logs because the
            -- annotations table keys on the log row, not on a group.
            (SELECT COUNT(*) FROM chat_message_annotations a
               JOIN chat_logs cl ON cl.id = a.chat_log_id
              WHERE cl.group_id = d.group_id
                AND a.intent = 'quit_signal'
                AND cl.created_at >= NOW() - ($1 || ' days')::interval
            )::int AS quit_signals,

            (SELECT COUNT(*) FROM chat_message_annotations a
               JOIN chat_logs cl ON cl.id = a.chat_log_id
              WHERE cl.group_id = d.group_id
                AND a.intent = 'complaint'
                AND cl.created_at >= NOW() - ($1 || ' days')::interval
            )::int AS complaints,

            -- NULL when nothing was annotated, which the scorer treats as "no
            -- information" rather than as neutral. A driver whose messages were
            -- never annotated has not been measured.
            (SELECT AVG(a.sentiment)::float FROM chat_message_annotations a
               JOIN chat_logs cl ON cl.id = a.chat_log_id
              WHERE cl.group_id = d.group_id
                AND a.sentiment IS NOT NULL
                AND cl.created_at >= NOW() - ($1 || ' days')::interval
            ) AS avg_sentiment,

            -- Silence, measured against this driver's own earlier volume. The
            -- baseline is the older half of the retained window and "recent" is
            -- the last week, so both come from inside the 30 days that exist.
            (SELECT COUNT(*) FROM chat_logs cl
              WHERE cl.group_id = d.group_id
                AND cl.created_at <  NOW() - INTERVAL '7 days'
                AND cl.created_at >= NOW() - ($1 || ' days')::interval
            )::int AS baseline_messages,

            (SELECT COUNT(*) FROM chat_logs cl
              WHERE cl.group_id = d.group_id
                AND cl.created_at >= NOW() - INTERVAL '7 days'
            )::int AS recent_messages,

            -- What the company did. Home requests that ended badly.
            (SELECT COUNT(*) FROM home_time_requests r
              WHERE r.group_id = d.group_id
                AND r.status IN ('expired', 'clarification_unanswered')
                AND r.requested_at >= NOW() - INTERVAL '90 days'
            )::int AS unanswered_home_requests,

            (SELECT COUNT(*) FROM home_time_requests r
              WHERE r.group_id = d.group_id
                AND r.status = 'denied'
                AND r.requested_at >= NOW() - INTERVAL '90 days'
            )::int AS denied_home_requests,

            -- Money earned and not handed over. The road bonus half is exact:
            -- bonus_usd is computed at insert and bonus_posted_at is set only
            -- when the summary actually went out.
            COALESCE((SELECT SUM(h.bonus_usd) FROM driver_road_history h
               WHERE h.group_id = d.group_id
                 AND h.bonus_usd > 0
                 AND h.bonus_posted_at IS NULL), 0)::int AS unpaid_bonus_usd,

            -- The mileage bonus is keyed on a NORMALISED NAME and has no group
            -- and no person of its own — the one real-money table in this
            -- application with no identity link, which is recorded as a known
            -- weakness in the brief. mileage_bonus_progress DOES carry a
            -- person_id (migration 0026), so it is the bridge, and a driver
            -- with no person resolved yet simply contributes nothing here.
            -- Under-counting is the right failure: a retention notice built on
            -- a name collision would name the wrong driver.
            (SELECT COUNT(*) FROM mileage_bonus_notifications n
              WHERE d.person_id IS NOT NULL
                AND n.driver_normalized_name IN (
                      SELECT p.driver_normalized_name FROM mileage_bonus_progress p
                       WHERE p.person_id = d.person_id
                    )
                AND (n.status IN ('rejected', 'disregarded') OR n.delivery_state = 'failed')
                AND n.created_at >= NOW() - INTERVAL '180 days'
            )::int AS unpaid_bonus_count,

            -- Sitting empty, from the load lifecycle rather than inferred.
            (SELECT l.phase_since FROM load_lifecycle l
              WHERE l.group_id = d.group_id AND l.phase = 'empty'
              ORDER BY l.phase_since ASC LIMIT 1) AS empty_since
       FROM driver d
      ORDER BY d.group_id`,
    [String(days)]
  );

  return res.rows.map(mapInputs);
}

/**
 * A database row as the pure scorer wants it.
 *
 * The road clock is turned into WEEKS OVER THE ALLOWANCE here rather than in
 * the scorer, because the allowance is a setting and the scorer must not read
 * settings. A driver who is at home has no road clock running, so it is zero
 * regardless of how long `state_since` says.
 */
function mapInputs(row) {
  const allowanceWeeks = Number(row.road_allowance_weeks || 4);
  const onRoad = row.state === 'road' && row.state_since;
  const daysOnRoad = onRoad
    ? Math.floor((Date.now() - new Date(row.state_since).getTime()) / 86400000)
    : 0;
  const weeksOver = onRoad
    ? Math.max(0, Math.floor(daysOnRoad / 7) - allowanceWeeks)
    : 0;

  return {
    personId: row.person_id ?? null,
    groupId: row.group_id,
    driverName: (row.driver_name || '').trim() || row.group_name || `Group ${row.group_id}`,
    driverType: row.driver_type || null,
    quitSignals: Number(row.quit_signals || 0),
    complaints: Number(row.complaints || 0),
    // null stays null: "never annotated" is not "neutral".
    avgSentiment: row.avg_sentiment === null ? null : Number(row.avg_sentiment),
    baselineMessages: Number(row.baseline_messages || 0),
    recentMessages: Number(row.recent_messages || 0),
    daysOnRoad,
    roadWeeksOverAllowance: weeksOver,
    unansweredHomeRequests: Number(row.unanswered_home_requests || 0),
    deniedHomeRequests: Number(row.denied_home_requests || 0),
    unpaidBonusUsd: Number(row.unpaid_bonus_usd || 0),
    unpaidBonusCount: Number(row.unpaid_bonus_count || 0),
    emptySince: row.empty_since || null,
    // Filled by the watcher from the efficiency classifier, which needs cycles
    // rather than counts and so cannot be a subselect here.
    brokenHomeCommitments: 0,
    raiseNotQualifiedRounds: 0,
  };
}

module.exports = {
  WINDOW_DAYS,
  gatherRetentionInputs,
  mapInputs,
};
