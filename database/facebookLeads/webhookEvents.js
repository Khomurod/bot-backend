/**
 * Verified Meta webhook EVENT QUEUE — database helpers.
 *
 * The lead-idempotency ledger. Two guarantees live in this SQL and must not be
 * weakened: the insert is `ON CONFLICT (event_key) DO NOTHING`, so a
 * re-delivered Meta lead can never be posted twice, and the claim is
 * `FOR UPDATE SKIP LOCKED`, so overlapping drains cannot work the same row.
 * Retries carry their own `next_retry_at`, which the worker sleeps until.
 *
 * Split out of database/facebookLeads.js, which re-exports every symbol here.
 */
const { query } = require('../pool');

async function insertFacebookWebhookEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const inserted = [];
  for (const event of events) {
    const res = await query(
      `INSERT INTO facebook_webhook_events (
         event_key,
         page_id,
         event_type,
         payload
       )
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (event_key) DO NOTHING
       RETURNING *`,
      [
        event.eventKey,
        String(event.pageId),
        event.eventType,
        JSON.stringify(event.payload || {}),
      ]
    );
    if (res.rows[0]) inserted.push(res.rows[0]);
  }
  return inserted;
}

async function claimPendingFacebookWebhookEvents(limit = 10) {
  const res = await query(
    `WITH candidates AS (
       SELECT id
         FROM facebook_webhook_events
        WHERE status IN ('pending', 'failed')
          AND next_retry_at <= NOW()
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE facebook_webhook_events e
        SET status = 'processing',
            attempt_count = e.attempt_count + 1,
            updated_at = NOW()
       FROM candidates
      WHERE e.id = candidates.id
      RETURNING e.*`,
    [limit]
  );
  return res.rows;
}

async function completeFacebookWebhookEvent(eventId) {
  const res = await query(
    `UPDATE facebook_webhook_events
        SET status = 'completed',
            processed_at = NOW(),
            updated_at = NOW(),
            last_error = NULL
      WHERE id = $1
      RETURNING *`,
    [eventId]
  );
  return res.rows[0] || null;
}

async function failFacebookWebhookEvent(eventId, errorMessage, nextRetryAt) {
  const res = await query(
    `UPDATE facebook_webhook_events
        SET status = 'failed',
            last_error = $1,
            next_retry_at = $2,
            updated_at = NOW()
      WHERE id = $3
      RETURNING *`,
    [String(errorMessage || 'Unknown error').slice(0, 2000), nextRetryAt, eventId]
  );
  return res.rows[0] || null;
}

async function resetFacebookWebhookEventByIdentifier(identifier) {
  const normalized = String(identifier || '').trim();
  if (!normalized) return null;
  const res = await query(
    `UPDATE facebook_webhook_events
        SET status = 'pending',
            next_retry_at = NOW(),
            updated_at = NOW(),
            last_error = NULL
      WHERE id::text = $1
         OR event_key = $1
         OR event_key LIKE '%' || $1
      RETURNING *`,
    [normalized]
  );
  return res.rows[0] || null;
}

async function getRecentFacebookWebhookEvents(limit = 50) {
  const cappedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const res = await query(
    `SELECT *
       FROM facebook_webhook_events
      ORDER BY created_at DESC
      LIMIT $1`,
    [cappedLimit]
  );
  return res.rows;
}

async function recordFacebookSenderSeen(pageId, senderId, firstEventKey) {
  const res = await query(
    `INSERT INTO facebook_seen_senders (
       page_id,
       sender_id,
       first_event_key,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (page_id, sender_id) DO NOTHING
     RETURNING page_id, sender_id`,
    [String(pageId), String(senderId), firstEventKey || null]
  );
  return res.rows.length > 0;
}

async function hasFacebookSenderBeenSeen(pageId, senderId) {
  const res = await query(
    `SELECT 1
       FROM facebook_seen_senders
      WHERE page_id = $1
        AND sender_id = $2
      LIMIT 1`,
    [String(pageId), String(senderId)]
  );
  return res.rows.length > 0;
}

module.exports = {
  insertFacebookWebhookEvents,
  claimPendingFacebookWebhookEvents,
  completeFacebookWebhookEvent,
  failFacebookWebhookEvent,
  resetFacebookWebhookEventByIdentifier,
  getRecentFacebookWebhookEvents,
  recordFacebookSenderSeen,
  hasFacebookSenderBeenSeen,
};
