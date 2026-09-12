'use strict';

/**
 * The finance document queue — enqueue, claim, finish.
 *
 * THE CLAIM IS THE WHOLE POINT OF THIS MODULE. `FOR UPDATE SKIP LOCKED` with
 * `LIMIT 1` is what makes the reader safe to run in more than one process and,
 * more importantly, what makes it sequential: two claimers cannot take the same
 * row, and one claimer cannot take two. The reader holds a whole document in
 * memory while it reads it, on an instance with 512MB, so "one at a time" is a
 * memory budget and not a preference.
 *
 * ATTEMPTS ARE INCREMENTED AT CLAIM TIME, not at failure. A worker that crashes
 * mid-read never reaches its failure handler, so counting on the way out lets a
 * poisoned row be retried forever. Counting on the way in bounds it. This is
 * the shape database/facebookLeads/webhookEvents.js and
 * database/homeTimeInternalAlertOutbox.js already use, and it was learned the
 * same way.
 *
 * NOTHING HERE LOGS A CAPTION, A FILE NAME OR EXTRACTED TEXT. Ids and statuses.
 * The document's contents are payment data and have one home.
 *
 * A DOWNLOAD URL IS NEVER STORED. Telegram's `getFileLink` embeds the BOT TOKEN
 * in the URL it returns; there is deliberately no column here it could go in,
 * and `last_error` is written by a caller that strips it.
 */
const { query } = require('./db');

/** Postgres: the relation does not exist — the one honest "not set up yet". */
const UNDEFINED_TABLE = '42P01';

/**
 * Record a document that arrived, ready to be read.
 *
 * `ON CONFLICT DO NOTHING` on `(chat_id, message_id, file_unique_id)`: an album
 * redelivered by Telegram, or an edit that re-reads the same message, must not
 * queue the same file twice. `file_unique_id` is the stable half — `file_id` is
 * per-bot and reissuable.
 *
 * @returns {Promise<{id: number|null, created: boolean}>}
 */
async function enqueueDocument(fields) {
  const { rows } = await query(
    `INSERT INTO finance_documents (
       message_ref_id, chat_id, message_id, kind, file_id, file_unique_id,
       mime_type, file_name, file_size, caption, media_group_id, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (chat_id, message_id, file_unique_id) DO NOTHING
     RETURNING id`,
    [
      fields.messageRefId, String(fields.chatId), Number(fields.messageId),
      fields.kind, fields.fileId, fields.fileUniqueId,
      fields.mimeType ?? null, fields.fileName ?? null, fields.fileSize ?? null,
      fields.caption ?? null, fields.mediaGroupId ?? null, fields.status || 'pending',
    ],
  );
  return { id: rows[0]?.id ?? null, created: Boolean(rows[0]) };
}

/**
 * Take exactly ONE document that is due, and mark it taken.
 *
 * The sub-select is `FOR UPDATE SKIP LOCKED`, so a concurrent claimer walks
 * past a locked row instead of waiting on it — an important difference, because
 * waiting would serialise two workers into one slow one rather than letting the
 * second find other work or find nothing.
 *
 * @returns {Promise<object|null>} the claimed row, or null when nothing is due
 */
async function claimNextDocument({ now = new Date() } = {}) {
  const { rows } = await query(
    `UPDATE finance_documents
        SET status = 'processing',
            attempt_count = attempt_count + 1,
            processing_started_at = $1,
            updated_at = NOW()
      WHERE id = (
        SELECT id FROM finance_documents
         WHERE status IN ('pending', 'failed')
           AND next_attempt_at <= $1
         ORDER BY next_attempt_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING id, message_ref_id AS "messageRefId", chat_id AS "chatId",
                message_id AS "messageId", kind, file_id AS "fileId",
                file_unique_id AS "fileUniqueId", mime_type AS "mimeType",
                file_name AS "fileName", file_size AS "fileSize",
                caption, attempt_count AS "attemptCount"`,
    [now],
  );
  const row = rows[0];
  if (!row) return null;
  return { ...row, fileSize: row.fileSize === null ? null : Number(row.fileSize) };
}

/**
 * A document that was read, or that a person now has to look at.
 *
 * One statement for both because they differ only in `status` and
 * `review_reason`, and splitting them invites the two to drift.
 */
async function finishDocument(id, {
  status, readMethod = null, textChars = null, extracted = null,
  reviewReason = null, aiProvider = null, aiModel = null,
}) {
  await query(
    `UPDATE finance_documents
        SET status = $2, read_method = $3, text_chars = $4, extracted = $5,
            review_reason = $6, ai_provider = $7, ai_model = $8,
            last_error = NULL, processing_started_at = NULL, updated_at = NOW()
      WHERE id = $1`,
    [id, status, readMethod, textChars,
      extracted === null ? null : JSON.stringify(extracted),
      reviewReason, aiProvider, aiModel],
  );
}

/**
 * A document that could not be FETCHED. Different from one that could not be
 * READ, which is `needs_review` and never comes back here.
 *
 * `nextAttemptAt` null means the ladder is exhausted: the row stays `failed`
 * and, because the due index only covers rows whose `next_attempt_at` has
 * passed, a far-future timestamp is used rather than NULL so the column's NOT
 * NULL contract holds and the row simply never becomes due again.
 */
async function failDocument(id, { error, nextAttemptAt = null }) {
  await query(
    `UPDATE finance_documents
        SET status = 'failed',
            last_error = LEFT($2, 500),
            next_attempt_at = COALESCE($3, 'infinity'::timestamptz),
            processing_started_at = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [id, String(error || 'unknown'), nextAttemptAt],
  );
}

/** Refused before any download: too large, or a type nothing here reads. */
async function skipDocument(id, { status, reason }) {
  await query(
    `UPDATE finance_documents
        SET status = $2, review_reason = LEFT($3, 200),
            next_attempt_at = 'infinity'::timestamptz,
            processing_started_at = NULL, updated_at = NOW()
      WHERE id = $1`,
    [id, status, String(reason || '')],
  );
}

/**
 * When the next retry comes due, for the wake scheduler.
 *
 * One query after a drain, instead of asking every few seconds whether the
 * moment has arrived. `'infinity'` rows are excluded by the comparison, so an
 * exhausted document never arms a timer.
 */
async function nextDueAt() {
  const { rows } = await query(
    `SELECT MIN(next_attempt_at) AS due
       FROM finance_documents
      WHERE status IN ('pending', 'failed')
        AND next_attempt_at < 'infinity'::timestamptz`,
  );
  return rows[0]?.due ?? null;
}

/**
 * Release a document stuck in `processing` — the crash case.
 *
 * A process that dies mid-read leaves its claim behind, and nothing else will
 * ever pick that row up: `processing` is in neither the due index nor the claim
 * query. Called at startup and from the sweep. The attempt already counted, so
 * a row that keeps crashing the worker still exhausts its ladder.
 */
async function releaseStuckDocuments({ olderThanMinutes = 15 } = {}) {
  const { rows } = await query(
    `UPDATE finance_documents
        SET status = 'pending', processing_started_at = NULL, updated_at = NOW()
      WHERE status = 'processing'
        AND processing_started_at < NOW() - ($1 || ' minutes')::interval
      RETURNING id`,
    [String(Math.max(1, Number(olderThanMinutes) || 15))],
  );
  return rows.length;
}

/**
 * Counts for the admin and the health block. Throws on a real database
 * failure; only a missing table answers "nothing yet", for the reason
 * database/financeSettings.js sets out at length.
 */
async function summariseDocuments() {
  try {
    const { rows } = await query(
      `SELECT status, COUNT(*)::int AS count FROM finance_documents GROUP BY status`,
    );
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.count]));
    return {
      available: true,
      byStatus,
      total: rows.reduce((sum, r) => sum + r.count, 0),
      needsReview: byStatus.needs_review ?? 0,
      failed: byStatus.failed ?? 0,
    };
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) {
      return { available: false, byStatus: {}, total: 0, needsReview: 0, failed: 0 };
    }
    throw err;
  }
}

module.exports = {
  enqueueDocument,
  claimNextDocument,
  finishDocument,
  failDocument,
  skipDocument,
  nextDueAt,
  releaseStuckDocuments,
  summariseDocuments,
};
