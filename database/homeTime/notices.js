/**
 * The manager-notice outbox: three home-time events, each told exactly once.
 *
 * The dedup guarantee is the whole point. "Driver is home" is re-derived by a
 * background check every few minutes, and an in-memory "already sent" set is
 * lost on every deploy — which on Render is several times a day. So the promise
 * lives in the schema: `event_key` is UNIQUE, and `enqueueNotice` is an
 * `ON CONFLICT DO NOTHING` insert. The tenth time the same arrival is derived,
 * the tenth insert changes nothing and three managers are not tagged again.
 *
 * Delivery is the proven durable-outbox shape used by
 * `homeTimeInternalAlertOutbox` and `samsara_video_recovery_jobs`: claim with
 * FOR UPDATE SKIP LOCKED under a lease, count the attempt AT CLAIM TIME so a
 * crash loop stays bounded, and back off inside the failing UPDATE so the delay
 * can never drift from the attempt count.
 */
const { query, pool } = require('../pool');

const DEFAULT_LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 6;
/** 1 min → 5 → 15 → 1 h → 3 h, then give up. Same ladder as the internal alert. */
const BACKOFF_SECONDS = [60, 300, 900, 3600, 10800];

function backoffSecondsFor(attempts) {
  const idx = Math.max(0, Math.min(BACKOFF_SECONDS.length - 1, Number(attempts) - 1));
  return BACKOFF_SECONDS[idx];
}

function mapNotice(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventKey: row.event_key,
    eventType: row.event_type,
    personId: row.person_id,
    groupId: row.group_id,
    roadHistoryId: row.road_history_id,
    requestId: row.request_id,
    chatId: row.chat_id,
    body: row.body,
    evidence: row.evidence_json || {},
    state: row.state,
    attempts: row.attempts,
    lastError: row.last_error,
    telegramMessageId: row.telegram_message_id,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

/**
 * Record one event for delivery. Returns the row when THIS call created it, and
 * `null` when the event was already known — so a caller can log "told" versus
 * "already told" without a second query, and can never send twice by accident.
 */
async function enqueueNotice({
  eventKey, eventType, chatId, body,
  personId = null, groupId = null, roadHistoryId = null, requestId = null,
  evidence = {},
}, client = null) {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `INSERT INTO home_time_manager_notices
       (event_key, event_type, person_id, group_id, road_history_id, request_id,
        chat_id, body, evidence_json, state, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'pending', NOW())
     ON CONFLICT (event_key) DO NOTHING
     RETURNING *`,
    [
      String(eventKey), String(eventType), personId, groupId, roadHistoryId, requestId,
      String(chatId), String(body), JSON.stringify(evidence || {}),
    ]
  );
  return mapNotice(res.rows[0]);
}

/** Was this exact event already recorded? Used by callers that build an expensive body. */
async function noticeExists(eventKey) {
  const res = await query(
    'SELECT 1 FROM home_time_manager_notices WHERE event_key = $1',
    [String(eventKey)]
  );
  return res.rows.length > 0;
}

/**
 * Claim up to `limit` due notices. Attempts are incremented HERE, not on
 * failure: a worker that dies mid-send has still spent an attempt, which is what
 * keeps a crash loop from retrying the same unsendable message forever.
 */
/**
 * Settle rows that spent their last attempt and never reached a settlement.
 *
 * A worker that dies after claiming the sixth attempt leaves the row 'pending'
 * with attempts = MAX. The claim below then excludes it forever, and
 * `countFailedNotices` only counts 'failed' — so the notice would be neither
 * retried nor reported: an alert nobody will ever receive, invisible. That is
 * precisely the shape of the 101 internal alerts that sat undelivered for
 * months, so it is swept at the top of every claim rather than left to luck.
 */
async function reapExhaustedNotices({ nowIso = null } = {}, client = null) {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `UPDATE home_time_manager_notices
        SET state = 'failed', claimed_until = NULL,
            last_error = COALESCE(last_error, 'attempts exhausted with no settlement')
      WHERE state = 'pending'
        AND attempts >= $1
        AND (claimed_until IS NULL OR claimed_until <= COALESCE($2::timestamptz, NOW()))
      RETURNING id`,
    [MAX_ATTEMPTS, nowIso]
  );
  return res.rows.map((r) => r.id);
}

/**
 * Take the lease on ONE known notice, for the caller that just created it.
 *
 * The immediate send needs this for the same reason the sweep does: a row is
 * due the moment it exists, so without a lease an inline send and a concurrent
 * sweep both hold it and three managers are tagged twice. The UNIQUE event key
 * stops a second ROW, never a second SEND.
 *
 * Returns null when someone else already holds it — which is a success: the
 * other worker will deliver it.
 */
async function claimNoticeById(id, { leaseSeconds = DEFAULT_LEASE_SECONDS, nowIso = null } = {}) {
  const res = await query(
    `UPDATE home_time_manager_notices
        SET claimed_until = COALESCE($3::timestamptz, NOW()) + ($2 || ' seconds')::interval,
            attempts = attempts + 1
      WHERE id = $1
        AND state = 'pending'
        AND attempts < $4
        AND (claimed_until IS NULL OR claimed_until <= COALESCE($3::timestamptz, NOW()))
      RETURNING *`,
    [id, String(leaseSeconds), nowIso, MAX_ATTEMPTS]
  );
  return mapNotice(res.rows[0]);
}

async function claimDueNotices({ limit = 10, leaseSeconds = DEFAULT_LEASE_SECONDS, nowIso = null } = {}) {
  await reapExhaustedNotices({ nowIso }).catch(() => {});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = await client.query(
      `SELECT id FROM home_time_manager_notices
        WHERE state = 'pending'
          AND next_attempt_at <= COALESCE($1::timestamptz, NOW())
          AND (claimed_until IS NULL OR claimed_until <= COALESCE($1::timestamptz, NOW()))
          AND attempts < $2
        ORDER BY next_attempt_at ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED`,
      [nowIso, MAX_ATTEMPTS, limit]
    );
    const ids = due.rows.map((r) => r.id);
    if (!ids.length) {
      await client.query('COMMIT');
      return [];
    }
    const claimed = await client.query(
      `UPDATE home_time_manager_notices
          SET claimed_until = COALESCE($2::timestamptz, NOW()) + ($3 || ' seconds')::interval,
              attempts = attempts + 1
        WHERE id = ANY($1::bigint[])
        RETURNING *`,
      [ids, nowIso, String(leaseSeconds)]
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

async function markNoticeDelivered(id, { telegramMessageId = null, nowIso = null } = {}) {
  const res = await query(
    `UPDATE home_time_manager_notices
        SET state = 'delivered',
            delivered_at = COALESCE($2::timestamptz, NOW()),
            claimed_until = NULL,
            last_error = NULL,
            telegram_message_id = COALESCE($3, telegram_message_id)
      WHERE id = $1
      RETURNING *`,
    [id, nowIso, telegramMessageId]
  );
  return mapNotice(res.rows[0]);
}

/**
 * Record a failed attempt and schedule the next one. The backoff is computed
 * from the row's own `attempts` INSIDE this statement, so it cannot drift from
 * the counter; at MAX_ATTEMPTS the row goes to 'failed' and stops.
 */
async function markNoticeFailed(id, error, { nowIso = null } = {}) {
  const res = await query(
    `UPDATE home_time_manager_notices
        SET state = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
            -- GREATEST(attempts, 1): PostgreSQL arrays are 1-based, so an
            -- attempts of 0 indexes nothing, the ladder yields NULL, and
            -- NOW() + NULL violates next_attempt_at NOT NULL. A failure on the
            -- very first attempt would then take the enqueue down with it.
            next_attempt_at = COALESCE($4::timestamptz, NOW())
              + (CASE
                   WHEN attempts >= $3 THEN 0
                   ELSE (ARRAY[60, 300, 900, 3600, 10800])[LEAST(GREATEST(attempts, 1), 5)]
                 END || ' seconds')::interval,
            claimed_until = NULL,
            last_error = LEFT($2, 500)
      WHERE id = $1
      RETURNING *`,
    [id, String(error || 'unknown error'), MAX_ATTEMPTS, nowIso]
  );
  return mapNotice(res.rows[0]);
}

/** Give up on a claim without spending the backoff (worker shutting down). */
async function releaseNoticeClaim(id) {
  await query('UPDATE home_time_manager_notices SET claimed_until = NULL WHERE id = $1', [id]);
}

/** How many notices will never be delivered — surfaced on /api/health beside the other queue. */
async function countFailedNotices() {
  const res = await query(
    `SELECT COUNT(*)::int AS n, MIN(created_at) AS oldest
       FROM home_time_manager_notices WHERE state = 'failed'`
  );
  return { count: res.rows[0]?.n || 0, oldestAt: res.rows[0]?.oldest || null };
}

/** The recent timeline for one driver, for the admin. Newest first. */
async function listNoticesForPerson(personId, { limit = 20 } = {}) {
  const res = await query(
    `SELECT * FROM home_time_manager_notices
      WHERE person_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [personId, limit]
  );
  return res.rows.map(mapNotice);
}

module.exports = {
  DEFAULT_LEASE_SECONDS,
  MAX_ATTEMPTS,
  BACKOFF_SECONDS,
  backoffSecondsFor,
  mapNotice,
  enqueueNotice,
  noticeExists,
  claimNoticeById,
  claimDueNotices,
  reapExhaustedNotices,
  markNoticeDelivered,
  markNoticeFailed,
  releaseNoticeClaim,
  countFailedNotices,
  listNoticesForPerson,
};
