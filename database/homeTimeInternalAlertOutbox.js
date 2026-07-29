/**
 * Internal clarification alert — durable outbox (database helpers).
 *
 * One alert per home-time request, so the request row IS the outbox entry (see
 * migration 0002). Every state transition is an atomic, guarded UPDATE; there is
 * no in-memory state and no timer that could be lost on restart.
 *
 * State machine (`internal_alert_state`):
 *
 *      NULL ──enqueue──► pending ──claim(lease)──► pending (claimed)
 *                           ▲                        │
 *                           │                        ├── success ──► delivered
 *                           └── failure / lease ─────┘
 *                               expiry (crash)              │
 *                                                           └── attempts
 *                                                              exhausted
 *                                                              ──► failed
 *
 * Crash safety comes from the LEASE, not from a release path running: a worker
 * that dies mid-send simply lets `internal_alert_claimed_until` expire, after
 * which the row is claimable again. That is the difference from the one-shot
 * `WHERE internal_alert_sent_at IS NULL` claim this replaces, which left a
 * crashed alert permanently stuck as "sent".
 *
 * `internal_alert_sent_at` (from 0001) is kept as the delivered-at timestamp.
 */
const { query } = require('./db');

// How long a worker holds a claim before it is considered dead and retryable.
const DEFAULT_LEASE_SECONDS = 120;
// Bounded retries with growing backoff, so a permanently bad chat id cannot spin.
const MAX_ATTEMPTS = 6;
const BACKOFF_SECONDS = [60, 300, 900, 3600, 10800];

// Clarifications still waiting on dates — the ones a stand-down must cover.
const OPEN_AWAITING_STATUSES = [
  'awaiting_dates', 'awaiting_home_start', 'awaiting_return_to_road',
];

/** Backoff for the Nth attempt (1-based), capped at the last step. */
function backoffSecondsFor(attempts) {
  const i = Math.max(0, Number(attempts || 1) - 1);
  return BACKOFF_SECONDS[Math.min(i, BACKOFF_SECONDS.length - 1)];
}

/**
 * Mark a request as needing an internal alert. Idempotent and non-destructive:
 * a row already delivered (or already pending) is left exactly as it is, so
 * calling this twice can never cause a second alert.
 */
async function enqueueInternalAlert(id, { nowIso = null } = {}) {
  const res = await query(
    `UPDATE home_time_requests
        SET internal_alert_state = 'pending',
            internal_alert_next_attempt_at = COALESCE($2::timestamptz, NOW()),
            internal_alert_attempts = 0,
            internal_alert_claimed_until = NULL
      WHERE id = $1
        AND internal_alert_sent_at IS NULL
        AND (internal_alert_state IS NULL OR internal_alert_state = 'pending')
      RETURNING *`,
    [id, nowIso]
  );
  return res.rows[0] || null;
}

/**
 * Claim up to `limit` due alerts for THIS worker.
 *
 * `FOR UPDATE SKIP LOCKED` makes concurrent workers take disjoint sets within
 * the statement; the `claimed_until` lease extends that guarantee across
 * transactions and processes. Attempts are incremented at CLAIM time (not at
 * failure) so a crash-loop is still bounded by MAX_ATTEMPTS.
 */
async function claimDueInternalAlerts({
  nowIso = null, limit = 10, leaseSeconds = DEFAULT_LEASE_SECONDS,
} = {}) {
  const res = await query(
    `UPDATE home_time_requests r
        SET internal_alert_claimed_until = COALESCE($1::timestamptz, NOW())
                                           + ($2 || ' seconds')::interval,
            internal_alert_attempts = r.internal_alert_attempts + 1
      WHERE r.id IN (
        SELECT id FROM home_time_requests
         WHERE internal_alert_state = 'pending'
           AND (internal_alert_next_attempt_at IS NULL
                OR internal_alert_next_attempt_at <= COALESCE($1::timestamptz, NOW()))
           AND (internal_alert_claimed_until IS NULL
                OR internal_alert_claimed_until <= COALESCE($1::timestamptz, NOW()))
         ORDER BY internal_alert_next_attempt_at NULLS FIRST, id
         LIMIT $3
         FOR UPDATE SKIP LOCKED
      )
      RETURNING r.*`,
    [nowIso, String(leaseSeconds), limit]
  );
  return res.rows;
}

/**
 * Claim ONE specific alert (the immediate attempt right after a request is
 * created). Same lease semantics as the sweep, so the worker still recovers it
 * if this process dies before Telegram answers.
 */
async function claimInternalAlertById(id, {
  nowIso = null, leaseSeconds = DEFAULT_LEASE_SECONDS,
} = {}) {
  const res = await query(
    `UPDATE home_time_requests
        SET internal_alert_claimed_until = COALESCE($2::timestamptz, NOW())
                                           + ($3 || ' seconds')::interval,
            internal_alert_attempts = internal_alert_attempts + 1
      WHERE id = $1
        AND internal_alert_state = 'pending'
        AND (internal_alert_claimed_until IS NULL
             OR internal_alert_claimed_until <= COALESCE($2::timestamptz, NOW()))
      RETURNING *`,
    [id, nowIso, String(leaseSeconds)]
  );
  return res.rows[0] || null;
}

/** Telegram accepted it. Terminal, and the guard stops any double-delivery. */
async function markInternalAlertDelivered(id, { nowIso = null } = {}) {
  const res = await query(
    `UPDATE home_time_requests
        SET internal_alert_state = 'delivered',
            internal_alert_sent_at = COALESCE($2::timestamptz, NOW()),
            internal_alert_claimed_until = NULL,
            internal_alert_next_attempt_at = NULL,
            internal_alert_last_error = NULL
      WHERE id = $1 AND internal_alert_state <> 'delivered'
      RETURNING *`,
    [id, nowIso]
  );
  return res.rows[0] || null;
}

/**
 * The send failed. Schedule a backoff retry, or give up once the bounded attempt
 * budget is spent. Releasing the lease here is an optimisation, not a
 * correctness requirement — the lease would expire on its own.
 */
async function markInternalAlertFailed(id, {
  error = null, nowIso = null, maxAttempts = MAX_ATTEMPTS,
} = {}) {
  // The backoff step is chosen from the row's OWN attempt count inside the same
  // statement (Postgres arrays are 1-indexed, so attempts=1 → the first step),
  // rather than from a separate read that could race a concurrent worker. The
  // ladder is passed in so BACKOFF_SECONDS stays the single source of truth.
  const res = await query(
    `UPDATE home_time_requests
        SET internal_alert_state = CASE
              WHEN internal_alert_attempts >= $3 THEN 'failed' ELSE 'pending' END,
            internal_alert_claimed_until = NULL,
            internal_alert_next_attempt_at = CASE
              WHEN internal_alert_attempts >= $3 THEN NULL
              ELSE COALESCE($4::timestamptz, NOW())
                   + (($5::int[])[LEAST(GREATEST(internal_alert_attempts, 1),
                                        array_length($5::int[], 1))] || ' seconds')::interval
              END,
            internal_alert_last_error = $2
      WHERE id = $1
      RETURNING *`,
    [id, error ? String(error).slice(0, 500) : null, maxAttempts, nowIso, BACKOFF_SECONDS]
  );
  return res.rows[0] || null;
}

/**
 * Hand the claim back WITHOUT counting the attempt — used when the send was
 * never tried because the internal group is not configured. The request stays
 * pending, so it delivers as soon as an admin sets the group.
 */
async function releaseInternalAlertClaim(id, { nowIso = null } = {}) {
  const res = await query(
    `UPDATE home_time_requests
        SET internal_alert_claimed_until = NULL,
            internal_alert_attempts = GREATEST(0, internal_alert_attempts - 1),
            internal_alert_next_attempt_at = COALESCE($2::timestamptz, NOW())
      WHERE id = $1 AND internal_alert_state = 'pending'
      RETURNING *`,
    [id, nowIso]
  );
  return res.rows[0] || null;
}

async function getInternalAlertRow(id) {
  const res = await query(
    `SELECT id, internal_alert_state, internal_alert_attempts, internal_alert_sent_at,
            internal_alert_next_attempt_at, internal_alert_claimed_until, internal_alert_last_error
       FROM home_time_requests WHERE id = $1`,
    [id]
  );
  return res.rows[0] || null;
}

/** How many alerts are waiting — for logging and tests. */
async function countPendingInternalAlerts({ nowIso = null } = {}) {
  const res = await query(
    `SELECT COUNT(*)::int AS n FROM home_time_requests
      WHERE internal_alert_state = 'pending'
        AND (internal_alert_next_attempt_at IS NULL
             OR internal_alert_next_attempt_at <= COALESCE($1::timestamptz, NOW()))`,
    [nowIso]
  );
  return res.rows[0]?.n || 0;
}

// ─── Silent-mode transition (bulk, DB-side) ──────────────────────────────────

/**
 * Clear the reminder clock on EVERY still-open clarification the moment driver
 * messaging is switched off.
 *
 * The reminder sweep alone is not enough: it only ever sees reminders that are
 * already DUE, so one scheduled for six hours from now survives, and fires if
 * the setting is switched back on before it comes due. One bulk UPDATE closes
 * that window immediately.
 *
 * Deliberately does NOT touch reminder_count, status, or the request itself —
 * the driver simply stops being chased; staff take over.
 *
 * @returns {number} how many schedules were cleared
 */
async function standDownAllDriverReminders() {
  const res = await query(
    `UPDATE home_time_requests
        SET next_reminder_at = NULL
      WHERE next_reminder_at IS NOT NULL
        AND status = ANY($1)
      RETURNING id`,
    [OPEN_AWAITING_STATUSES]
  );
  return res.rows.length;
}

/**
 * Move every still-open clarification that was being handled through the DRIVER
 * channel over to the internal/staff channel, and enqueue an alert for each one
 * that has not already been delivered.
 *
 * Sends nothing itself — delivery is the worker's job — so no driver group can
 * be touched during the transition.
 *
 * @returns {{ switched:number, enqueued:number }}
 */
async function switchOpenClarificationsToInternal({ nowIso = null } = {}) {
  const switched = await query(
    `UPDATE home_time_requests
        SET clarification_channel = 'internal'
      WHERE status = ANY($1)
        AND (clarification_channel IS DISTINCT FROM 'internal')
      RETURNING id`,
    [OPEN_AWAITING_STATUSES]
  );
  const enqueued = await query(
    `UPDATE home_time_requests
        SET internal_alert_state = 'pending',
            internal_alert_next_attempt_at = COALESCE($2::timestamptz, NOW()),
            internal_alert_claimed_until = NULL
      WHERE status = ANY($1)
        AND clarification_channel = 'internal'
        AND internal_alert_sent_at IS NULL
        AND (internal_alert_state IS NULL OR internal_alert_state = 'pending')
      RETURNING id`,
    [OPEN_AWAITING_STATUSES, nowIso]
  );
  return { switched: switched.rows.length, enqueued: enqueued.rows.length };
}

module.exports = {
  DEFAULT_LEASE_SECONDS,
  MAX_ATTEMPTS,
  BACKOFF_SECONDS,
  OPEN_AWAITING_STATUSES,
  backoffSecondsFor,
  enqueueInternalAlert,
  claimDueInternalAlerts,
  claimInternalAlertById,
  markInternalAlertDelivered,
  markInternalAlertFailed,
  releaseInternalAlertClaim,
  getInternalAlertRow,
  countPendingInternalAlerts,
  standDownAllDriverReminders,
  switchOpenClarificationsToInternal,
};
