'use strict';

/**
 * Whether each background worker has actually run. One row per service.
 *
 * THE AMBIGUITY THIS REMOVES. A pass that finds nothing writes nothing, so
 * every table a worker owns looks exactly the same whether the worker ran and
 * had nothing to do or its timer was never armed. Three services kept a
 * `lastRun` in process memory, which a Render restart reset to null —
 * indistinguishable from "this has never worked". The rest kept nothing at all.
 *
 * NOT A RUN HISTORY, deliberately: a row per tick would be the largest table in
 * the database within a month and nobody would read the old rows. What is kept
 * is the last outcome and the counters needed to tell "failing since Tuesday"
 * from "failed once at lunchtime".
 *
 * NOTHING HERE THROWS. A ledger that can break the worker it is watching is a
 * worse problem than the one it solves, so every function swallows and reports.
 */
const { query } = require('./pool');

/** The closed vocabulary. `blocked` is configuration, not failure. */
const RUN_STATUSES = Object.freeze(['ok', 'error', 'skipped', 'blocked']);

/** A summary is a few counts; a stack trace or a payload is not. */
const MAX_ERROR_CHARS = 400;
const MAX_SUMMARY_CHARS = 4000;

function mapRow(row) {
  if (!row) return null;
  return {
    serviceKey: row.service_key,
    lastStartedAt: row.last_started_at,
    lastFinishedAt: row.last_finished_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastSummary: row.last_summary || null,
    lastOkAt: row.last_ok_at,
    lastErrorAt: row.last_error_at,
    consecutiveFailures: Number(row.consecutive_failures || 0),
    runsTotal: Number(row.runs_total || 0),
    failuresTotal: Number(row.failures_total || 0),
    expectedIntervalSeconds: row.expected_interval_seconds == null
      ? null : Number(row.expected_interval_seconds),
    updatedAt: row.updated_at,
  };
}

/**
 * A summary safe to store: counts and short strings only.
 *
 * A pass summary is written by twenty different workers and read back onto a
 * PUBLIC health endpoint. Anything long is a payload, a message body or an
 * error text somebody will regret publishing, so depth and size are capped here
 * rather than trusted to each caller.
 */
function safeSummary(summary) {
  if (summary == null || typeof summary !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(summary)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value)) out[key] = value.length;
    else if (typeof value === 'string') out[key] = value.slice(0, 200);
  }
  const text = JSON.stringify(out);
  return text.length > MAX_SUMMARY_CHARS ? null : out;
}

/** Mark a pass as started. Returns false if it could not be recorded. */
async function recordRunStart(serviceKey, { expectedIntervalSeconds = null } = {}) {
  if (!serviceKey) return false;
  try {
    await query(
      `INSERT INTO background_service_runs
         (service_key, last_started_at, expected_interval_seconds, updated_at)
       VALUES ($1, NOW(), $2, NOW())
       ON CONFLICT (service_key) DO UPDATE SET
         last_started_at = NOW(),
         expected_interval_seconds =
           COALESCE(EXCLUDED.expected_interval_seconds, background_service_runs.expected_interval_seconds),
         updated_at = NOW()`,
      [String(serviceKey), expectedIntervalSeconds]
    );
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Mark a pass as finished.
 *
 * `consecutive_failures` resets on anything that is not an error — including
 * `skipped` and `blocked`, because neither is the worker failing. `runs_total`
 * counts every completed pass so an operator can see the difference between a
 * worker that has run twice and one that has run nine thousand times.
 */
async function recordRunFinish(serviceKey, {
  status = 'ok', error = null, summary = null, expectedIntervalSeconds = null,
} = {}) {
  if (!serviceKey) return false;
  const state = RUN_STATUSES.includes(status) ? status : 'ok';
  const failed = state === 'error';
  try {
    await query(
      `INSERT INTO background_service_runs
         (service_key, last_started_at, last_finished_at, last_status, last_error,
          last_summary, last_ok_at, last_error_at, consecutive_failures, runs_total,
          failures_total, expected_interval_seconds, updated_at)
       VALUES ($1, NOW(), NOW(), $2, $3, $4::jsonb,
               CASE WHEN $5 THEN NULL ELSE NOW() END,
               CASE WHEN $5 THEN NOW() ELSE NULL END,
               CASE WHEN $5 THEN 1 ELSE 0 END, 1, CASE WHEN $5 THEN 1 ELSE 0 END, $6, NOW())
       ON CONFLICT (service_key) DO UPDATE SET
         last_finished_at = NOW(),
         last_status = EXCLUDED.last_status,
         last_error = EXCLUDED.last_error,
         last_summary = EXCLUDED.last_summary,
         last_ok_at = CASE WHEN $5 THEN background_service_runs.last_ok_at ELSE NOW() END,
         last_error_at = CASE WHEN $5 THEN NOW() ELSE background_service_runs.last_error_at END,
         consecutive_failures =
           CASE WHEN $5 THEN background_service_runs.consecutive_failures + 1 ELSE 0 END,
         runs_total = background_service_runs.runs_total + 1,
         failures_total = background_service_runs.failures_total + CASE WHEN $5 THEN 1 ELSE 0 END,
         expected_interval_seconds =
           COALESCE(EXCLUDED.expected_interval_seconds, background_service_runs.expected_interval_seconds),
         updated_at = NOW()`,
      [
        String(serviceKey), state,
        error ? String(error).slice(0, MAX_ERROR_CHARS) : null,
        safeSummary(summary), failed, expectedIntervalSeconds,
      ]
    );
    return true;
  } catch (_) {
    return false;
  }
}

async function getRun(serviceKey) {
  try {
    const res = await query(
      'SELECT * FROM background_service_runs WHERE service_key = $1', [String(serviceKey)]
    );
    return mapRow(res.rows[0]);
  } catch (_) {
    return null;
  }
}

/** Every recorded worker, newest silence first. */
async function listRuns() {
  try {
    const res = await query(
      'SELECT * FROM background_service_runs ORDER BY last_finished_at DESC NULLS FIRST'
    );
    return res.rows.map(mapRow);
  } catch (_) {
    return [];
  }
}

/** A Map keyed by service, for a caller comparing the whole catalog at once. */
async function getRunMap() {
  const rows = await listRuns();
  return new Map(rows.map((r) => [r.serviceKey, r]));
}

module.exports = {
  RUN_STATUSES,
  safeSummary,
  recordRunStart,
  recordRunFinish,
  getRun,
  listRuns,
  getRunMap,
};
