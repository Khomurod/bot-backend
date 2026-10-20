'use strict';

/**
 * The queue of recruiting-group conversations to read for a Bitrix stage.
 *
 * ONE ROW PER CONVERSATION (the candidate post every reply leads back to).
 * Every new message in it sets the row back to `pending`, pushes `due_at` out
 * by the settle delay and bumps `revision`, so a burst — Safety's PDFs, then
 * the sentence — is read once, after it stops arriving.
 *
 * The claim is a lease, exactly as in database/safetyApprovals/reviews.js: a
 * worker finishes a row only at the revision it claimed, so a conversation
 * that moved on while it was being read is read again.
 *
 * NOTHING HERE LOGS MESSAGE TEXT.
 */

const { query, pool } = require('../pool');
const { mapMessageRow: mapMessage } = require('../safetyApprovals/messages');

const UNDEFINED_TABLE = '42P01';
const DEFAULT_LEASE_SECONDS = 300;

function mapThread(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    chatId: row.chat_id,
    rootMessageId: Number(row.root_message_id),
    lastMessageId: Number(row.last_message_id),
    status: row.status,
    attempts: Number(row.attempts),
    revision: Number(row.revision),
    dueAt: row.due_at,
    lastError: row.last_error || null,
    outcome: row.outcome || null,
    updatedAt: row.updated_at,
  };
}

/** Queue (or re-queue) a conversation, to be read `settleSeconds` from now. */
async function enqueueThread({ chatId, rootMessageId, lastMessageId, settleSeconds }) {
  const { rows } = await query(
    `INSERT INTO hiring_stage_threads (chat_id, root_message_id, last_message_id, due_at)
     VALUES ($1, $2, $3, NOW() + make_interval(secs => $4))
     ON CONFLICT (chat_id, root_message_id) DO UPDATE
        SET status = 'pending',
            last_message_id = GREATEST(hiring_stage_threads.last_message_id, EXCLUDED.last_message_id),
            due_at = EXCLUDED.due_at,
            attempts = 0,
            last_error = NULL,
            revision = hiring_stage_threads.revision + 1,
            updated_at = NOW()
     RETURNING *`,
    [String(chatId), Number(rootMessageId), Number(lastMessageId), Number(settleSeconds)],
  );
  return mapThread(rows[0]);
}

async function claimDueThreads({ limit = 5, leaseSeconds = DEFAULT_LEASE_SECONDS } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = await client.query(
      `SELECT id FROM hiring_stage_threads
        WHERE status = 'pending' AND due_at <= NOW()
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
      `UPDATE hiring_stage_threads
          SET claimed_until = NOW() + make_interval(secs => $2),
              attempts = attempts + 1, updated_at = NOW()
        WHERE id = ANY($1::bigint[])
        RETURNING *`,
      [ids, leaseSeconds],
    );
    await client.query('COMMIT');
    return claimed.rows.map(mapThread);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function releaseLease(thread) {
  await query('UPDATE hiring_stage_threads SET claimed_until = NULL, updated_at = NOW() WHERE id = $1', [thread.id]);
}

/** Close a read at the revision it was claimed at. @returns whether it closed. */
async function finishThread(thread, { status = 'done', outcome = null, error = null } = {}) {
  const result = await query(
    `UPDATE hiring_stage_threads
        SET status = $3, outcome = $4::jsonb, last_error = $5, claimed_until = NULL, updated_at = NOW()
      WHERE id = $1 AND revision = $2`,
    [thread.id, thread.revision, status, outcome === null ? null : JSON.stringify(outcome), error],
  );
  if (!result.rowCount) await releaseLease(thread);
  return result.rowCount > 0;
}

async function retryThread(thread, { delaySeconds, error = null }) {
  const result = await query(
    `UPDATE hiring_stage_threads
        SET due_at = NOW() + make_interval(secs => $3), last_error = $4,
            claimed_until = NULL, updated_at = NOW()
      WHERE id = $1 AND revision = $2`,
    [thread.id, thread.revision, Number(delaySeconds), error],
  );
  if (!result.rowCount) await releaseLease(thread);
  return result.rowCount > 0;
}

async function nextThreadDueAt() {
  try {
    const { rows } = await query(
      `SELECT MIN(GREATEST(due_at, COALESCE(claimed_until, due_at))) AS due
         FROM hiring_stage_threads WHERE status = 'pending'`,
    );
    return rows[0]?.due || null;
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return null;
    throw err;
  }
}

/**
 * Every captured message of one conversation: the post (and its album), and
 * everything that leads back to it by replies, at any depth, with the other
 * items of any album a reply belongs to. Oldest first.
 */
async function listThreadMessages(chatId, rootMessageId, limit = 80) {
  const { rows } = await query(
    `WITH RECURSIVE root AS (
       SELECT r.* FROM safety_approval_messages r
        WHERE r.chat_id = $1 AND r.message_id = $2
     ), post AS (
       SELECT m.* FROM safety_approval_messages m, root
        WHERE m.chat_id = $1
          AND (m.message_id = root.message_id
               OR (root.media_group_id IS NOT NULL AND m.media_group_id = root.media_group_id))
     ), tree AS (
       SELECT post.message_id, post.media_group_id, 0 AS depth FROM post
       UNION
       SELECT m.message_id, m.media_group_id, tree.depth + 1
         FROM safety_approval_messages m
         JOIN tree ON m.chat_id = $1 AND m.reply_to_message_id = tree.message_id
        WHERE tree.depth < 30
     )
     SELECT * FROM safety_approval_messages
      WHERE chat_id = $1
        AND (message_id IN (SELECT message_id FROM tree)
             OR media_group_id IN (SELECT media_group_id FROM tree WHERE media_group_id IS NOT NULL))
      ORDER BY message_id
      LIMIT $3`,
    [String(chatId), Number(rootMessageId), Number(limit)],
  );
  return rows.map(mapMessage);
}

/** A queue row whose messages are gone (purged at sixty days) has nothing left to read. */
async function purgeOldThreads(days = 60) {
  try {
    const result = await query(
      `DELETE FROM hiring_stage_threads
        WHERE updated_at < NOW() - make_interval(days => $1) AND status <> 'pending'`,
      [Number(days)],
    );
    return result.rowCount || 0;
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return 0;
    throw err;
  }
}

module.exports = {
  DEFAULT_LEASE_SECONDS,
  purgeOldThreads,
  enqueueThread,
  claimDueThreads,
  finishThread,
  retryThread,
  nextThreadDueAt,
  listThreadMessages,
};
