/**
 * Database helpers for the smart BOL/POD intake pipeline.
 * Uses the shared pool/query exported from db.js.
 *
 * Idempotency / safety guards baked into the SQL here:
 *   - telegram_document_files.telegram_file_unique_id is UNIQUE, so a resent or
 *     echoed file is dropped (addFileToBatch returns null) instead of being
 *     processed / uploaded twice.
 *   - media_group_id is UNIQUE, so every file of one Telegram album lands in a
 *     single batch even across separate updates.
 *   - claimBatchForUpload flips waiting_confirmation → uploading atomically, so
 *     two people (or a double-tap) clicking "Yes" cannot upload twice.
 */
const { query } = require('./db');

const OPEN = 'collecting';

/** Create a fresh batch (single file or quick-consecutive group, no album). */
async function createBatch({
  telegramChatId, groupId = null, telegramUserId = null, senderUsername = null,
  mediaGroupId = null, expiresAt = null,
}) {
  const res = await query(
    `INSERT INTO telegram_document_batches
       (telegram_chat_id, group_id, telegram_user_id, sender_username,
        media_group_id, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'collecting', $6)
     RETURNING *`,
    [telegramChatId, groupId, telegramUserId, senderUsername, mediaGroupId, expiresAt]
  );
  return res.rows[0] || null;
}

/**
 * Get (or create) the single batch for a Telegram album. ON CONFLICT on the
 * unique media_group_id means concurrent updates for the same album converge on
 * one row. Only refreshes updated_at; never resurrects a finalized batch's
 * status.
 */
async function getOrCreateBatchForMediaGroup({
  mediaGroupId, telegramChatId, groupId = null, telegramUserId = null,
  senderUsername = null, expiresAt = null,
}) {
  const res = await query(
    `INSERT INTO telegram_document_batches
       (telegram_chat_id, group_id, telegram_user_id, sender_username,
        media_group_id, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'collecting', $6)
     ON CONFLICT (media_group_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [telegramChatId, groupId, telegramUserId, senderUsername, mediaGroupId, expiresAt]
  );
  return res.rows[0] || null;
}

/**
 * Find the still-open batch for a sender in a chat within a recency window —
 * used to group quick consecutive files that carry no media_group_id.
 */
async function findOpenBatchForSender({ telegramChatId, telegramUserId, windowSeconds = 8 }) {
  const res = await query(
    `SELECT * FROM telegram_document_batches
      WHERE telegram_chat_id = $1
        AND telegram_user_id IS NOT DISTINCT FROM $2
        AND media_group_id IS NULL
        AND status = 'collecting'
        AND created_at > NOW() - ($3 * INTERVAL '1 second')
      ORDER BY created_at DESC
      LIMIT 1`,
    [telegramChatId, telegramUserId, windowSeconds]
  );
  return res.rows[0] || null;
}

/**
 * Add one file to a batch. Returns the inserted row, or null when the file's
 * telegram_file_unique_id was already recorded (duplicate — silently ignored).
 */
async function addFileToBatch(batchId, file) {
  const res = await query(
    // NOTE: the dedup guard is the PARTIAL unique index idx_tg_doc_files_unique_id
    // (schema.sql), defined WHERE telegram_file_unique_id IS NOT NULL. Postgres
    // will NOT infer a partial index from a bare column list, so
    // `ON CONFLICT (telegram_file_unique_id)` raises
    //   "there is no unique or exclusion constraint matching the ON CONFLICT
    //    specification"
    // and the whole insert throws. We use the un-targeted `ON CONFLICT DO
    // NOTHING`, which matches ANY unique/exclusion violation on the row. This
    // table's only unique constraint is that partial index, so duplicate
    // protection is unchanged — a resent/echoed file still yields no row
    // (returns null) instead of a duplicate insert.
    `INSERT INTO telegram_document_files
       (batch_id, telegram_file_id, telegram_file_unique_id, telegram_message_id,
        file_name, mime_type, file_size, kind, local_path, sha256, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      batchId,
      file.telegramFileId || null,
      file.telegramFileUniqueId || null,
      file.telegramMessageId || null,
      file.fileName || null,
      file.mimeType || null,
      file.fileSize != null ? Number(file.fileSize) : null,
      file.kind || null,
      file.localPath || null,
      file.sha256 || null,
      Number.isInteger(file.sortOrder) ? file.sortOrder : 0,
    ]
  );
  return res.rows[0] || null;
}

async function listBatchFiles(batchId) {
  const res = await query(
    `SELECT * FROM telegram_document_files
      WHERE batch_id = $1
      ORDER BY sort_order ASC, telegram_message_id ASC, id ASC`,
    [batchId]
  );
  return res.rows;
}

async function getBatchById(id) {
  const res = await query('SELECT * FROM telegram_document_batches WHERE id = $1', [id]);
  return res.rows[0] || null;
}

// Columns updateBatch is allowed to set (whitelist → no SQL injection via keys).
const BATCH_UPDATABLE = new Set([
  'status', 'detected_doc_type', 'datatruck_order_id', 'datatruck_load_reference',
  'match_confidence', 'confidence', 'ai_summary', 'confirmation_chat_id',
  'confirmation_message_id', 'decided_by_user_id', 'decided_by_username', 'expires_at',
]);

async function updateBatch(id, patch = {}) {
  const sets = [];
  const params = [id];
  for (const [key, value] of Object.entries(patch)) {
    if (!BATCH_UPDATABLE.has(key)) continue;
    params.push(value);
    sets.push(`${key} = $${params.length}`);
  }
  if (!sets.length) return getBatchById(id);
  sets.push('updated_at = NOW()');
  const res = await query(
    `UPDATE telegram_document_batches SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    params
  );
  return res.rows[0] || null;
}

/**
 * Atomically claim a batch that is waiting for confirmation for upload. Returns
 * the claimed row, or null when it is no longer claimable (already uploading /
 * uploaded / ignored) — the caller then replies "Already handled." This is the
 * idempotency guard for double-clicked inline buttons.
 */
async function claimBatchForUpload(id, { decidedByUserId = null, decidedByUsername = null } = {}) {
  const res = await query(
    `UPDATE telegram_document_batches
        SET status = 'uploading', claimed_at = NOW(), updated_at = NOW(),
            decided_by_user_id = COALESCE($2, decided_by_user_id),
            decided_by_username = COALESCE($3, decided_by_username)
      WHERE id = $1 AND status = 'waiting_confirmation'
      RETURNING *`,
    [id, decidedByUserId, decidedByUsername]
  );
  return res.rows[0] || null;
}

/**
 * Record a decision that does not upload (No → needs_review, Disregard →
 * ignored). Only transitions from waiting_confirmation so a late click after an
 * upload cannot rewrite a terminal state. Returns the row, or null if not
 * applicable.
 */
async function markBatchDecision(id, { status, decidedByUserId = null, decidedByUsername = null }) {
  const res = await query(
    `UPDATE telegram_document_batches
        SET status = $2, updated_at = NOW(),
            decided_by_user_id = COALESCE($3, decided_by_user_id),
            decided_by_username = COALESCE($4, decided_by_username)
      WHERE id = $1 AND status = 'waiting_confirmation'
      RETURNING *`,
    [id, status, decidedByUserId, decidedByUsername]
  );
  return res.rows[0] || null;
}

async function recordUploadAttempt({
  batchId = null, orderId = null, loadReference = null, documentType = null,
  sha256 = null, status = 'pending', dryRun = false,
}) {
  const res = await query(
    `INSERT INTO datatruck_upload_attempts
       (batch_id, order_id, load_reference, document_type, sha256, status, dry_run)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [batchId, orderId, loadReference, documentType, sha256, status, dryRun === true]
  );
  return res.rows[0] || null;
}

async function markUploadAttempt(id, { status, datatruckDocumentId = null, errorMessage = null }) {
  const res = await query(
    `UPDATE datatruck_upload_attempts
        SET status = $2,
            datatruck_document_id = COALESCE($3, datatruck_document_id),
            error_message = $4,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, status, datatruckDocumentId, errorMessage ? String(errorMessage).slice(0, 500) : null]
  );
  return res.rows[0] || null;
}

/**
 * Has this exact document already been uploaded to this load? Matches on the
 * content hash first (strongest), else on (order, document type). Used to skip
 * a duplicate upload before hitting the Datatruck API.
 */
async function findUploadedAttempt({ orderId, documentType, sha256 = null }) {
  if (sha256) {
    const byHash = await query(
      `SELECT * FROM datatruck_upload_attempts
        WHERE sha256 = $1 AND order_id IS NOT DISTINCT FROM $2
          AND status IN ('uploaded','dry_run')
        ORDER BY created_at DESC LIMIT 1`,
      [sha256, orderId != null ? String(orderId) : null]
    );
    if (byHash.rows[0]) return byHash.rows[0];
  }
  if (orderId != null && documentType) {
    const byType = await query(
      `SELECT * FROM datatruck_upload_attempts
        WHERE order_id = $1 AND document_type = $2 AND status = 'uploaded'
        ORDER BY created_at DESC LIMIT 1`,
      [String(orderId), documentType]
    );
    if (byType.rows[0]) return byType.rows[0];
  }
  return null;
}

/**
 * Was a document of this (order, type) uploaded by OUR bot recently? The
 * Datatruck→Telegram forwarding poller calls this to suppress re-forwarding a
 * file the bot itself just uploaded (loop prevention). A generous default
 * window covers the poll interval plus Datatruck processing lag.
 */
async function findBotOriginatedUpload({ orderId, documentType, withinHours = 72 }) {
  if (orderId == null || !documentType) return null;
  // Only a LIVE 'uploaded' row created a real Datatruck document that could be
  // re-forwarded — a dry_run created nothing, so it must never suppress a
  // genuine external upload.
  const res = await query(
    `SELECT * FROM datatruck_upload_attempts
      WHERE order_id = $1 AND document_type = $2
        AND status = 'uploaded'
        AND created_at > NOW() - ($3 * INTERVAL '1 hour')
      ORDER BY created_at DESC LIMIT 1`,
    [String(orderId), documentType, withinHours]
  );
  return res.rows[0] || null;
}

/** Recent batches for the admin/status surface. */
async function listRecentBatches(limit = 100) {
  const res = await query(
    `SELECT b.*,
            (SELECT COUNT(*) FROM telegram_document_files f WHERE f.batch_id = b.id) AS file_count
       FROM telegram_document_batches b
      ORDER BY b.created_at DESC
      LIMIT $1`,
    [limit]
  );
  return res.rows;
}

/** Counts by status for the admin/status surface. */
async function batchStatusCounts() {
  const res = await query(
    `SELECT status, COUNT(*)::int AS count
       FROM telegram_document_batches
      GROUP BY status`
  );
  const out = {};
  for (const row of res.rows) out[row.status] = row.count;
  return out;
}

/**
 * Expire batches still 'collecting' past their expires_at (a debounce window
 * that never got finalized because the process restarted). Returns rows moved
 * to 'failed' so a scan can pick them up. Safe housekeeping only.
 */
async function expireStaleCollectingBatches() {
  const res = await query(
    `UPDATE telegram_document_batches
        SET status = 'failed', updated_at = NOW()
      WHERE status = 'collecting'
        AND expires_at IS NOT NULL
        AND expires_at < NOW() - INTERVAL '10 minutes'
      RETURNING id`
  );
  return res.rowCount || 0;
}

module.exports = {
  OPEN,
  createBatch,
  getOrCreateBatchForMediaGroup,
  findOpenBatchForSender,
  addFileToBatch,
  listBatchFiles,
  getBatchById,
  updateBatch,
  claimBatchForUpload,
  markBatchDecision,
  recordUploadAttempt,
  markUploadAttempt,
  findUploadedAttempt,
  findBotOriginatedUpload,
  listRecentBatches,
  batchStatusCounts,
  expireStaleCollectingBatches,
};
