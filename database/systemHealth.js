'use strict';

/**
 * Whether each part of Wenze is working, and what the readers were last told.
 *
 * A thin store around `lib/operations/healthTransitions.js`, which does all the
 * deciding. This file reads a row, hands it to the pure function, and writes
 * what comes back — so the rule for when a failure is worth mentioning can be
 * tested without a database anywhere near it.
 *
 * `announced_status` is the column that matters and it is easy to misread: it
 * is not what is true, it is what was last SAID. Recovery is announced only
 * where a failure was announced, so a blip that self-corrects inside the
 * threshold produces zero messages rather than one.
 */
const { query } = require('./pool');

function mapRow(row) {
  if (!row) return null;
  return {
    component: row.component,
    status: row.status,
    since: row.since,
    consecutiveFailures: Number(row.consecutive_failures || 0),
    consecutiveOk: Number(row.consecutive_ok || 0),
    announcedStatus: row.announced_status,
    lastError: row.last_error,
    transitions: Array.isArray(row.transitions) ? row.transitions : [],
    flappingSince: row.flapping_since,
    updatedAt: row.updated_at,
  };
}

async function getHealthState(component) {
  const res = await query('SELECT * FROM system_health_states WHERE component = $1', [component]);
  return mapRow(res.rows[0]);
}

/** Write back whatever the pure transition function produced. */
async function saveHealthState(state) {
  const res = await query(
    `INSERT INTO system_health_states
       (component, status, since, consecutive_failures, consecutive_ok,
        announced_status, last_error, transitions, flapping_since)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (component) DO UPDATE
       SET status = EXCLUDED.status,
           since = EXCLUDED.since,
           consecutive_failures = EXCLUDED.consecutive_failures,
           consecutive_ok = EXCLUDED.consecutive_ok,
           announced_status = EXCLUDED.announced_status,
           last_error = EXCLUDED.last_error,
           transitions = EXCLUDED.transitions,
           flapping_since = EXCLUDED.flapping_since,
           updated_at = NOW()
     RETURNING *`,
    [
      state.component, state.status, state.since,
      state.consecutiveFailures || 0, state.consecutiveOk || 0,
      state.announcedStatus, state.lastError,
      JSON.stringify(state.transitions || []), state.flappingSince,
    ]
  );
  return mapRow(res.rows[0]);
}

/** Everything observed, for the health endpoint and the screen. */
async function listHealthStates() {
  const res = await query('SELECT * FROM system_health_states ORDER BY component');
  return res.rows.map(mapRow);
}

/**
 * The one line `/api/health` wants.
 *
 * A component whose status is NULL has never been observed, and is counted
 * separately from one known to be working: "not checked" and "fine" are
 * different answers and only one of them is reassuring.
 */
async function summariseHealthStates() {
  const res = await query(
    `SELECT COUNT(*) FILTER (WHERE status = 'ok')::int AS ok,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked,
            COUNT(*) FILTER (WHERE status IS NULL)::int AS unchecked,
            COUNT(*) FILTER (WHERE flapping_since IS NOT NULL)::int AS flapping,
            ARRAY_REMOVE(ARRAY_AGG(component) FILTER (WHERE status = 'failed'), NULL) AS down,
            ARRAY_REMOVE(ARRAY_AGG(component) FILTER (WHERE status = 'blocked'), NULL)
              AS waiting
       FROM system_health_states`
  );
  const row = res.rows[0] || {};
  return {
    ok: Number(row.ok || 0),
    failed: Number(row.failed || 0),
    // SWITCHED OFF, COUNTED SEPARATELY, AND NEVER IN `down`. Production read
    // `failed: 3, down: [the Dispatcher Board, the weekly finance report, the
    // finance document reader]` for three features nobody had switched on —
    // which is how a real outage gets lost among things that were never
    // started. `waiting` names them; `down` is only what broke.
    blocked: Number(row.blocked || 0),
    waiting: row.waiting || [],
    unchecked: Number(row.unchecked || 0),
    flapping: Number(row.flapping || 0),
    down: row.down || [],
  };
}

module.exports = {
  mapRow,
  getHealthState,
  saveHealthState,
  listHealthStates,
  summariseHealthStates,
};
