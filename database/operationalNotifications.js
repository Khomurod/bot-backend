/**
 * The operational-notice outbox — the one every new feature delivers through.
 *
 * This is the FOURTH copy of the durable-outbox shape in this repository and
 * deliberately the last: `homeTimeInternalAlertOutbox`, `homeTime/notices` and
 * `samsara_video_recovery_jobs` each earned theirs before there was a general
 * one. A fifth would mean a fifth place to look when a queue goes quiet, and
 * queues going quiet unnoticed is the failure that started all of this.
 *
 * The shape, unchanged because it is proven:
 *   - claim with FOR UPDATE SKIP LOCKED under a lease, so two processes cannot
 *     send the same notice;
 *   - increment `attempts` AT CLAIM TIME, so a worker that crashes mid-send
 *     still burns an attempt and a crash loop stays bounded;
 *   - apply the backoff inside the failing UPDATE, so the delay cannot drift
 *     from the attempt count;
 *   - reach a terminal `abandoned` state rather than retrying forever, and make
 *     that count visible.
 */
const { query, pool } = require('./pool');

const DEFAULT_LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 6;
/** 1 min → 5 → 15 → 1 h → 3 h, then give up. */
const BACKOFF_SECONDS = [60, 300, 900, 3600, 10800];

function backoffSecondsFor(attempts) {
  const idx = Math.max(0, Math.min(BACKOFF_SECONDS.length - 1, Number(attempts) - 1));
  return BACKOFF_SECONDS[idx];
}

function mapNotice(row) {
  if (!row) return null;
  return {
    id: row.id,
    noticeKey: row.notice_key,
    category: row.category,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    personId: row.person_id,
    groupId: row.group_id,
    chatId: row.chat_id,
    routedVia: row.routed_via,
    body: row.body,
    evidence: row.evidence_json || null,
    state: row.state,
    attempts: row.attempts,
    lastError: row.last_error,
    telegramMessageId: row.telegram_message_id,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

/**
 * Record a notice to be sent.
 *
 * @returns {Promise<object|null>} the row, or NULL when this exact notice is
 *   already known — which is the dedup guarantee, not an error. A caller that
 *   treats null as a failure will double-send the moment it retries.
 */
async function enqueueNotification({
  noticeKey, category, chatId, routedVia = 'default', body,
  subjectType = null, subjectId = null, personId = null, groupId = null, evidence = null,
}, client = null) {
  const run = client ? (t, v) => client.query(t, v) : query;
  const res = await run(
    `INSERT INTO operational_notifications
       (notice_key, category, subject_type, subject_id, person_id, group_id,
        chat_id, routed_via, body, evidence_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT (notice_key) DO NOTHING
     RETURNING *`,
    [
      noticeKey, category, subjectType, subjectId == null ? null : String(subjectId),
      personId, groupId, String(chatId), routedVia, body,
      evidence ? JSON.stringify(evidence) : null,
    ]
  );
  return mapNotice(res.rows[0]) || null;
}

/**
 * Has this notice been sent recently enough that saying it again would be noise?
 *
 * A condition that is still true a week later IS worth repeating, which is why
 * this is a window rather than the UNIQUE constraint alone. Callers that want
 * "once, ever" put an immutable discriminator in the key instead.
 */
async function noticeSentWithin(noticeKeyPrefix, hours) {
  const res = await query(
    `SELECT 1 FROM operational_notifications
      WHERE notice_key LIKE $1 || '%'
        AND state = 'delivered'
        AND delivered_at > NOW() - ($2 || ' hours')::interval
      LIMIT 1`,
    [noticeKeyPrefix, String(hours)]
  );
  return res.rowCount > 0;
}

/**
 * One notice by id, claimed under a lease. Used for an immediate send.
 *
 * The lease and the attempt limit are checked HERE, not only in the batch
 * claim. The sweep runs on its own timer and can reach a freshly inserted row
 * in the moment between the enqueue and this call; a claim that looked only at
 * `state = 'pending'` would succeed anyway, and both callers would send the
 * same notice — defeating the one guarantee this table exists to make.
 *
 * Returning null when somebody else holds the lease is the correct outcome, and
 * the caller treats it as a success: the sweep owns that notice now.
 */
async function claimNotificationById(id, { leaseSeconds = DEFAULT_LEASE_SECONDS } = {}) {
  const res = await query(
    `UPDATE operational_notifications
        SET claimed_until = NOW() + ($2 || ' seconds')::interval,
            attempts = attempts + 1,
            updated_at = NOW()
      WHERE id = $1
        AND state = 'pending'
        AND (claimed_until IS NULL OR claimed_until <= NOW())
        AND attempts < $3
      RETURNING *`,
    [id, String(leaseSeconds), MAX_ATTEMPTS]
  );
  return mapNotice(res.rows[0]) || null;
}

/**
 * Move rows that have burned every attempt to a terminal state.
 *
 * Without this they stay `pending` forever, invisible to the "is anything
 * stuck?" count and skipped by every claim because `attempts >= MAX`. That is
 * exactly how 101 undelivered alerts sat unnoticed for months.
 */
async function reapExhaustedNotifications() {
  const res = await query(
    `UPDATE operational_notifications
        SET state = 'abandoned', updated_at = NOW()
      WHERE state = 'pending' AND attempts >= $1
      RETURNING id`,
    [MAX_ATTEMPTS]
  );
  return res.rowCount;
}

/** Claim a batch of due notices. Reaps exhausted rows first. */
async function claimDueNotifications({ limit = 10, leaseSeconds = DEFAULT_LEASE_SECONDS } = {}) {
  await reapExhaustedNotifications().catch(() => {});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = await client.query(
      `SELECT id FROM operational_notifications
        WHERE state = 'pending'
          AND next_attempt_at <= NOW()
          AND (claimed_until IS NULL OR claimed_until <= NOW())
          AND attempts < $1
        ORDER BY next_attempt_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [MAX_ATTEMPTS, limit]
    );
    const ids = due.rows.map((r) => r.id);
    if (!ids.length) {
      await client.query('COMMIT');
      return [];
    }
    const claimed = await client.query(
      `UPDATE operational_notifications
          SET claimed_until = NOW() + ($2 || ' seconds')::interval,
              attempts = attempts + 1,
              updated_at = NOW()
        WHERE id = ANY($1::bigint[])
        RETURNING *`,
      [ids, String(leaseSeconds)]
    );
    await client.query('COMMIT');
    return claimed.rows.map(mapNotice);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function markNotificationDelivered(id, { telegramMessageId = null } = {}) {
  const res = await query(
    `UPDATE operational_notifications
        SET state = 'delivered', delivered_at = NOW(), claimed_until = NULL,
            last_error = NULL, telegram_message_id = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, telegramMessageId]
  );
  return mapNotice(res.rows[0]);
}

/**
 * Record a failure and schedule the next try.
 *
 * The delay is computed INSIDE the failing UPDATE, from the row's own attempt
 * count, so it cannot drift from it — reading the count in JS and writing the
 * delay back is two statements a concurrent claim can interleave with.
 *
 * `GREATEST(attempts, 1)` is load-bearing: PostgreSQL arrays are 1-based, so an
 * attempts of 0 indexes nothing, the ladder yields NULL, and NOW() + NULL
 * violates `next_attempt_at NOT NULL` — a failure on the very first attempt
 * would take the whole enqueue down with it.
 */
async function markNotificationFailed(id, error) {
  const res = await query(
    `UPDATE operational_notifications
        SET state = CASE WHEN attempts >= $3 THEN 'abandoned' ELSE 'pending' END,
            claimed_until = NULL,
            last_error = LEFT($2, 500),
            next_attempt_at = NOW() + (CASE
              WHEN attempts >= $3 THEN 0
              ELSE (ARRAY[60, 300, 900, 3600, 10800])[LEAST(GREATEST(attempts, 1), 5)]
            END || ' seconds')::interval,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, String(error || 'unknown error'), MAX_ATTEMPTS]
  );
  return mapNotice(res.rows[0]);
}

/** Release a claim without counting it as a failure (a clean shutdown). */
async function releaseNotificationClaim(id) {
  await query(
    'UPDATE operational_notifications SET claimed_until = NULL, updated_at = NOW() WHERE id = $1',
    [id]
  );
}

/** For /api/health: what is stuck, and how long it has been stuck. */
async function summariseNotifications() {
  const res = await query(
    `SELECT COUNT(*) FILTER (WHERE state = 'pending')::int   AS pending,
            COUNT(*) FILTER (WHERE state = 'failed')::int    AS failed,
            COUNT(*) FILTER (WHERE state = 'abandoned')::int AS abandoned,
            COUNT(*) FILTER (WHERE state = 'delivered'
                             AND delivered_at > NOW() - INTERVAL '24 hours')::int AS delivered24h,
            MIN(created_at) FILTER (WHERE state = 'pending') AS oldest_pending_at
       FROM operational_notifications`
  );
  const r = res.rows[0] || {};
  return {
    pending: r.pending || 0,
    failed: r.failed || 0,
    abandoned: r.abandoned || 0,
    delivered24h: r.delivered24h || 0,
    oldestPendingAt: r.oldest_pending_at || null,
  };
}

module.exports = {
  MAX_ATTEMPTS,
  BACKOFF_SECONDS,
  backoffSecondsFor,
  enqueueNotification,
  noticeSentWithin,
  claimNotificationById,
  claimDueNotifications,
  reapExhaustedNotifications,
  markNotificationDelivered,
  markNotificationFailed,
  releaseNotificationClaim,
  summariseNotifications,
};
