'use strict';

/**
 * The queue of Safety replies to read, and what was posted because of them.
 *
 * ONE ROW PER SAFETY REPLY (`safety_key`: the album, or the single message).
 * Every new item or edit of that reply sets it back to `pending`, pushes
 * `due_at` out by the settle delay and bumps `revision`: an album arrives one
 * item at a time, and the reply is read once it has stopped arriving.
 *
 * THE CLAIM IS A LEASE (FOR UPDATE SKIP LOCKED, `claimed_until`), so two
 * workers never read the same reply and a crashed one's row comes back. A
 * worker finishes a row only at the revision it claimed: a reply edited while
 * it was being read stays `pending` and is read again.
 *
 * ANNOUNCEMENTS ARE THE MEMORY OF WHAT WAS POSTED. The same decision for the
 * same driver on the same post is never posted twice; a changed one is. The
 * row is reserved before the send (see reserveAnnouncement).
 */

const { query, pool } = require('../pool');

const UNDEFINED_TABLE = '42P01';
const DEFAULT_LEASE_SECONDS = 300;

function mapReview(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    chatId: row.chat_id,
    safetyKey: row.safety_key,
    safetyUserId: row.safety_user_id === null ? null : String(row.safety_user_id),
    // null: a decision written on its own, not as a reply (migration 0077).
    postMessageId: row.post_message_id === null ? null : Number(row.post_message_id),
    status: row.status,
    attempts: Number(row.attempts),
    revision: Number(row.revision),
    dueAt: row.due_at,
    lastError: row.last_error || null,
    outcome: row.outcome || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Queue (or re-queue) a Safety reply, to be read `settleSeconds` from now. */
async function enqueueReview({ chatId, safetyKey, safetyUserId, postMessageId, settleSeconds }) {
  const { rows } = await query(
    `INSERT INTO safety_approval_reviews (chat_id, safety_key, safety_user_id, post_message_id, due_at)
     VALUES ($1, $2, $3, $4, NOW() + make_interval(secs => $5))
     ON CONFLICT (chat_id, safety_key) DO UPDATE
        SET status = 'pending',
            post_message_id = EXCLUDED.post_message_id,
            safety_user_id = EXCLUDED.safety_user_id,
            due_at = EXCLUDED.due_at,
            attempts = 0,
            last_error = NULL,
            revision = safety_approval_reviews.revision + 1,
            updated_at = NOW()
     RETURNING *`,
    [String(chatId), safetyKey, safetyUserId ?? null, postMessageId == null ? null : Number(postMessageId),
      Number(settleSeconds)],
  );
  return mapReview(rows[0]);
}

/** The review a Safety reply album already has, if any item of it replied. */
async function getReviewByKey(chatId, safetyKey) {
  const { rows } = await query(
    'SELECT * FROM safety_approval_reviews WHERE chat_id = $1 AND safety_key = $2',
    [String(chatId), safetyKey],
  );
  return mapReview(rows[0]);
}

async function claimDueReviews({ limit = 5, leaseSeconds = DEFAULT_LEASE_SECONDS } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = await client.query(
      `SELECT id FROM safety_approval_reviews
        WHERE status = 'pending'
          AND due_at <= NOW()
          AND (claimed_until IS NULL OR claimed_until <= NOW())
        ORDER BY due_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    const ids = due.rows.map((r) => r.id);
    if (!ids.length) {
      await client.query('COMMIT');
      return [];
    }
    const claimed = await client.query(
      `UPDATE safety_approval_reviews
          SET claimed_until = NOW() + make_interval(secs => $2),
              attempts = attempts + 1,
              updated_at = NOW()
        WHERE id = ANY($1::bigint[])
        RETURNING *`,
      [ids, leaseSeconds],
    );
    await client.query('COMMIT');
    return claimed.rows.map(mapReview);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A finish that lost the race with a newer revision still gives the lease
 * back, so the newer revision is read now and not when the lease runs out.
 */
async function releaseLease(review) {
  await query(
    'UPDATE safety_approval_reviews SET claimed_until = NULL, updated_at = NOW() WHERE id = $1',
    [review.id],
  );
}

/** Close a review at the revision it was claimed at. @returns whether it closed. */
async function finishReview(review, { status, outcome = null, error = null }) {
  const result = await query(
    `UPDATE safety_approval_reviews
        SET status = $3, outcome = $4::jsonb, last_error = $5,
            claimed_until = NULL, updated_at = NOW()
      WHERE id = $1 AND revision = $2`,
    [review.id, review.revision, status, outcome === null ? null : JSON.stringify(outcome), error],
  );
  if (!result.rowCount) await releaseLease(review);
  return result.rowCount > 0;
}

/** Try again later. `countAttempt: false` gives the attempt back (a wait, not a failure). */
async function retryReview(review, { delaySeconds, error = null, countAttempt = true }) {
  const result = await query(
    `UPDATE safety_approval_reviews
        SET due_at = NOW() + make_interval(secs => $3), last_error = $4,
            attempts = attempts - CASE WHEN $5 THEN 0 ELSE 1 END,
            claimed_until = NULL, updated_at = NOW()
      WHERE id = $1 AND revision = $2`,
    [review.id, review.revision, Number(delaySeconds), error, countAttempt],
  );
  if (!result.rowCount) await releaseLease(review);
  return result.rowCount > 0;
}

/** When the queue next has something to do, or null. */
async function nextReviewDueAt() {
  try {
    const { rows } = await query(
      `SELECT MIN(GREATEST(due_at, COALESCE(claimed_until, due_at))) AS due
         FROM safety_approval_reviews WHERE status = 'pending'`,
    );
    return rows[0]?.due || null;
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return null;
    throw err;
  }
}

async function listRecentReviews(limit = 30) {
  try {
    const { rows } = await query(
      'SELECT * FROM safety_approval_reviews ORDER BY updated_at DESC LIMIT $1',
      [Math.min(Math.max(Number(limit) || 30, 1), 100)],
    );
    return rows.map(mapReview);
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return [];
    throw err;
  }
}

/**
 * Claim the right to post this decision, BEFORE posting it.
 *
 * Under a transaction-scoped advisory lock on (chat, post, driver), so two
 * workers cannot both see "not posted yet": the latest row for this driver on
 * this post — reserved or sent — is read, and a new row is reserved only when
 * its decision differs. A reservation counts as posted from that moment, so a
 * database failure after Telegram accepted the post can never post it twice.
 * At most once, on purpose: a duplicate APPROVED is worse than a missing one,
 * which a person sees in Settings → Safety Approvals.
 *
 * @returns {Promise<{id: number}|null>} null when this decision is already posted
 */
async function reserveAnnouncement({
  chatId, postMessageId, driverKey, driverName, decision, reviewId,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `safety_approval:${chatId}:${postMessageId}:${driverKey}`,
    ]);
    const last = await client.query(
      `SELECT decision FROM safety_approval_announcements
        WHERE chat_id = $1 AND post_message_id = $2 AND driver_key = $3
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [String(chatId), Number(postMessageId), driverKey],
    );
    if (last.rows[0]?.decision === decision) {
      await client.query('COMMIT');
      return null;
    }
    const { rows } = await client.query(
      `INSERT INTO safety_approval_announcements
         (chat_id, post_message_id, driver_key, driver_name, decision, review_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [String(chatId), Number(postMessageId), driverKey, driverName, decision, reviewId ?? null],
    );
    await client.query('COMMIT');
    return { id: Number(rows[0].id) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The post went out: record where. */
async function completeAnnouncement(id, topicMessageIds) {
  await query(
    `UPDATE safety_approval_announcements
        SET sent_at = NOW(), topic_message_ids = $2::bigint[]
      WHERE id = $1`,
    [id, (topicMessageIds || []).map(Number)],
  );
}

/** Telegram refused the post: give the reservation back so a retry may send it. */
async function releaseAnnouncement(id) {
  await query('DELETE FROM safety_approval_announcements WHERE id = $1 AND sent_at IS NULL', [id]);
}

module.exports = {
  enqueueReview,
  getReviewByKey,
  claimDueReviews,
  finishReview,
  retryReview,
  nextReviewDueAt,
  listRecentReviews,
  reserveAnnouncement,
  completeAnnouncement,
  releaseAnnouncement,
  DEFAULT_LEASE_SECONDS,
};
