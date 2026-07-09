/**
 * Database helpers for Datatruck BOL/POD document delivery.
 * Uses the shared pool/query exported from db.js.
 *
 * The UNIQUE `signature` column is the idempotency guard: each (order,
 * document) pair is forwarded to a driver group at most once. Failed sends and
 * documents whose group did not exist yet stay retryable (within an attempt
 * cap) so a later scan can deliver them; sent/backfill rows are terminal.
 */
const { query } = require('./db');

// Versioned activation key: this rollout establishes a fresh "live uploads
// only" boundary so documents already in Datatruck cannot be sent as new.
const SERVICE_NAME = 'datatruck_doc_delivery_live_uploads_v1';
const ACTIVATION_RUN_KEY = 'activation';

/**
 * The durable moment this live-upload rollout first went live. Documents
 * uploaded before this are treated as backfill and never sent. Stored once in
 * service_runs so it survives restarts (process start time would not).
 * @returns {Promise<Date>}
 */
async function ensureActivationTime() {
  await query(
    `INSERT INTO service_runs (service_name, run_key)
     VALUES ($1, $2)
     ON CONFLICT (service_name, run_key) DO NOTHING`,
    [SERVICE_NAME, ACTIVATION_RUN_KEY]
  );
  const res = await query(
    `SELECT ran_at FROM service_runs WHERE service_name = $1 AND run_key = $2`,
    [SERVICE_NAME, ACTIVATION_RUN_KEY]
  );
  return res.rows[0]?.ran_at ? new Date(res.rows[0].ran_at) : new Date();
}

/**
 * Record a document that existed before activation (or before a configured
 * cutoff) as suppressed backfill so it is never sent and never reconsidered.
 * No-op if the signature already exists.
 * @returns {Promise<boolean>} true when a new suppression row was inserted.
 */
async function recordBackfillSuppressed(meta) {
  const res = await query(
    `INSERT INTO datatruck_document_deliveries
       (signature, order_id, load_reference, file_type, file_link, uploaded_by,
        uploaded_at, driver_name, unit_number, status, attempt_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'suppressed_backfill', 0)
     ON CONFLICT (signature) DO NOTHING
     RETURNING id`,
    [
      meta.signature,
      meta.orderId || null,
      meta.loadReference || null,
      meta.fileType,
      meta.fileLink || null,
      meta.uploadedBy || null,
      meta.uploadedAt || null,
      meta.driverName || null,
      meta.unitNumber || null,
    ]
  );
  return res.rows.length > 0;
}

/**
 * Claim a document for delivery. Inserts a fresh pending row, or re-claims a
 * previously failed / no-group / stale-pending row (within the attempt cap).
 * Returns the claimed row, or null when there is nothing to do (already sent,
 * suppressed, or another worker holds a fresh pending claim).
 */
async function claimDocumentDelivery(meta, { staleMinutes = 60, maxAttempts = 6 } = {}) {
  const res = await query(
    `INSERT INTO datatruck_document_deliveries
       (signature, order_id, load_reference, file_type, file_link, uploaded_by,
        uploaded_at, driver_name, unit_number, status, attempt_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', 1)
     ON CONFLICT (signature) DO UPDATE SET
       file_link = EXCLUDED.file_link,
       load_reference = EXCLUDED.load_reference,
       driver_name = EXCLUDED.driver_name,
       unit_number = EXCLUDED.unit_number,
       status = 'pending',
       attempt_count = datatruck_document_deliveries.attempt_count + 1,
       last_error = NULL,
       updated_at = NOW()
     WHERE datatruck_document_deliveries.status IN ('failed', 'skipped_no_group', 'pending')
       AND datatruck_document_deliveries.attempt_count < $10
       AND datatruck_document_deliveries.updated_at < NOW() - ($11 * INTERVAL '1 minute')
     RETURNING *`,
    [
      meta.signature,
      meta.orderId || null,
      meta.loadReference || null,
      meta.fileType,
      meta.fileLink || null,
      meta.uploadedBy || null,
      meta.uploadedAt || null,
      meta.driverName || null,
      meta.unitNumber || null,
      maxAttempts,
      staleMinutes,
    ]
  );
  return res.rows[0] || null;
}

async function markSent(id, { groupId, telegramGroupId, messageId, matchedBy }) {
  const res = await query(
    `UPDATE datatruck_document_deliveries
     SET status = 'sent',
         group_id = $2,
         telegram_group_id = $3,
         telegram_message_id = $4,
         matched_by = $5,
         last_error = NULL,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, groupId || null, telegramGroupId || null, messageId || null, matchedBy || null]
  );
  return res.rows[0] || null;
}

async function markFailed(id, error) {
  const res = await query(
    `UPDATE datatruck_document_deliveries
     SET status = 'failed', last_error = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, String(error || '').slice(0, 500)]
  );
  return res.rows[0] || null;
}

async function markSkippedNoGroup(id, { driverName, unitNumber } = {}) {
  const res = await query(
    `UPDATE datatruck_document_deliveries
     SET status = 'skipped_no_group',
         driver_name = COALESCE($2, driver_name),
         unit_number = COALESCE($3, unit_number),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, driverName || null, unitNumber || null]
  );
  return res.rows[0] || null;
}

/** Recent delivery rows for the admin/debug surface. */
async function listRecentDeliveries(limit = 100) {
  const res = await query(
    `SELECT * FROM datatruck_document_deliveries
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}

module.exports = {
  SERVICE_NAME,
  ensureActivationTime,
  recordBackfillSuppressed,
  claimDocumentDelivery,
  markSent,
  markFailed,
  markSkippedNoGroup,
  listRecentDeliveries,
};
