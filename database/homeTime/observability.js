/**
 * What Home Time is actually DOING right now, as numbers, for /api/health.
 *
 * This exists because the three things Phase 4 promised cannot otherwise be
 * checked in production without a database connection: that the return-to-road
 * watcher is running rather than merely deployed, that the manager notices are
 * one-per-event rather than repeating, and that requests now settle as
 * `recorded` instead of piling up waiting for an approval nobody gives.
 *
 * COUNTS AND TIMESTAMPS ONLY. No driver name, no chat id, no group id, no
 * notice body — /api/health is public and unauthenticated. Every function here
 * returns a plain object of integers and ISO timestamps, and the caller treats
 * a throw as `available: false` rather than letting it reach the endpoint.
 */
const { query } = require('../pool');

/**
 * The watch table: who is being watched and what the last verdict said.
 *
 * `watching` above zero with a recent `lastCheckedAt` is the proof the worker
 * ticks in production. Both zero means either nobody is home (legitimate, and
 * the cheap case the watcher is designed around) or the worker never started —
 * `oldestCheckedAt` separates them: a stale oldest with rows present is a
 * worker that has stopped.
 */
async function summariseReturnWatch() {
  const res = await query(
    `SELECT COUNT(*)::int AS watching,
            COUNT(*) FILTER (WHERE last_confidence = 'high')::int   AS high,
            COUNT(*) FILTER (WHERE last_confidence = 'medium')::int AS medium,
            COUNT(*) FILTER (WHERE last_confidence = 'low')::int    AS low,
            COUNT(*) FILTER (WHERE anchor_lat IS NOT NULL)::int     AS anchored,
            MAX(last_checked_at) AS last_checked_at,
            MIN(last_checked_at) AS oldest_checked_at
       FROM home_time_return_watch`
  );
  const r = res.rows[0] || {};
  return {
    watching: r.watching || 0,
    anchored: r.anchored || 0,
    high: r.high || 0,
    medium: r.medium || 0,
    low: r.low || 0,
    lastCheckedAt: r.last_checked_at || null,
    oldestCheckedAt: r.oldest_checked_at || null,
  };
}

/**
 * The manager notices, by event and by state, over the last seven days.
 *
 * `events` and `rows` are reported separately on purpose. `event_key` is UNIQUE,
 * so they are equal by construction — and reporting both means a regression
 * that broke the constraint would show as a difference rather than as a number
 * nobody can check. This is the "no duplicate manager notifications" promise,
 * observable from outside.
 */
async function summariseManagerNotices() {
  const res = await query(
    `SELECT event_type,
            COUNT(*)::int                                        AS rows,
            COUNT(DISTINCT event_key)::int                       AS events,
            COUNT(*) FILTER (WHERE state = 'delivered')::int     AS delivered,
            COUNT(*) FILTER (WHERE state = 'pending')::int       AS pending,
            COUNT(*) FILTER (WHERE state = 'failed')::int        AS failed,
            COUNT(*) FILTER (WHERE state = 'abandoned')::int     AS abandoned
       FROM home_time_manager_notices
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY event_type
      ORDER BY event_type`
  );
  const byEvent = {};
  for (const row of res.rows) {
    byEvent[row.event_type] = {
      rows: row.rows,
      events: row.events,
      delivered: row.delivered,
      pending: row.pending,
      failed: row.failed,
      abandoned: row.abandoned,
    };
  }
  return byEvent;
}

/**
 * Requests by status, all time.
 *
 * The point of the number is the SHAPE, not the total: `recorded` rising while
 * `pending` stays frozen at its historical value is what "the approval workflow
 * is retired and the old rows were preserved" looks like from outside.
 */
async function summariseRequestStatuses() {
  const res = await query(
    `SELECT status, COUNT(*)::int AS n FROM home_time_requests GROUP BY status ORDER BY status`
  );
  const out = {};
  for (const row of res.rows) out[row.status] = row.n;
  return out;
}

/** How many automatic Home → Road changes the registry has applied, and reversed. */
async function summariseReturnCorrections() {
  const res = await query(
    `SELECT COUNT(*)::int AS applied,
            COUNT(*) FILTER (WHERE reverted_at IS NOT NULL)::int AS reverted,
            MAX(applied_at) AS last_applied_at
       FROM operational_corrections
      WHERE action_key = 'home_time.mark_returned_to_road'`
  );
  const r = res.rows[0] || {};
  return {
    applied: r.applied || 0,
    reverted: r.reverted || 0,
    lastAppliedAt: r.last_applied_at || null,
  };
}

module.exports = {
  summariseReturnWatch,
  summariseManagerNotices,
  summariseRequestStatuses,
  summariseReturnCorrections,
};
