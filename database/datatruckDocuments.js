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

// ── Per-destination helpers (admin-controlled BOL/POD forwarding) ───────────
// One delivery row per document signature tracks TWO destinations independently
// so a partial failure retries only the failed side. Column names come from a
// fixed internal map (never user input), so interpolating them is safe.
const DEST_COLUMNS = {
  driver: {
    status: 'status',
    attempt: 'attempt_count',
    lastError: 'last_error',
    tgGroup: 'telegram_group_id',
    tgMsg: 'telegram_message_id',
  },
  central: {
    status: 'central_status',
    attempt: 'central_attempt_count',
    lastError: 'central_last_error',
    tgGroup: 'central_telegram_group_id',
    tgMsg: 'central_telegram_message_id',
  },
};

const DRIVER_SKIP_STATUSES = new Set([
  'skipped_no_group', 'skipped_not_applicable', 'skipped_same_group',
  'skipped_unclear', 'skipped_duplicate',
]);
const CENTRAL_SKIP_STATUSES = new Set([
  'skipped_not_applicable', 'skipped_same_group', 'skipped_unclear', 'skipped_duplicate',
]);

const RETRY_BASE_MINUTES = 5;   // first retry after ~5 min
const RETRY_MAX_MINUTES = 60;   // exponential backoff capped at 60 min

/**
 * Ensure a delivery row exists for this document. Fresh rows start both
 * destinations 'pending'; the caller then marks destinations not in the current
 * routing mode as skipped. Never resets an existing row's statuses (idempotent).
 * @returns {Promise<{row: object|null, isNew: boolean}>}
 */
async function upsertDelivery(meta) {
  const inserted = await query(
    `INSERT INTO datatruck_document_deliveries
       (signature, order_id, load_reference, file_type, file_link, uploaded_by,
        uploaded_at, driver_name, unit_number, doc_classification,
        classification_source, status, central_status, attempt_count, central_attempt_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending','pending',0,0)
     ON CONFLICT (signature) DO NOTHING
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
      meta.classification || null,
      meta.classificationSource || null,
    ]
  );
  if (inserted.rows[0]) return { row: inserted.rows[0], isNew: true };
  const existing = await query(
    'SELECT * FROM datatruck_document_deliveries WHERE signature = $1',
    [meta.signature]
  );
  return { row: existing.rows[0] || null, isNew: false };
}

/**
 * Atomically claim one destination for sending: flips its status to
 * 'processing' and increments its attempt counter, but ONLY when eligible —
 * fresh 'pending', or a 'failed'/'skipped_no_group'/stale-'processing' row whose
 * exponential-backoff window has elapsed, and under the attempt cap. Because the
 * UPDATE is atomic on a single row, two processes cannot both claim it.
 * @returns {Promise<object|null>} the claimed row, or null when not claimable.
 */
async function claimDestination(id, destination, { maxAttempts = 6 } = {}) {
  const c = DEST_COLUMNS[destination];
  if (!c) throw new Error(`Unknown destination: ${destination}`);
  const res = await query(
    `UPDATE datatruck_document_deliveries
     SET ${c.status} = 'processing',
         ${c.attempt} = ${c.attempt} + 1,
         updated_at = NOW()
     WHERE id = $1
       AND ${c.attempt} < $2
       AND (
         ${c.status} = 'pending'
         OR (${c.status} IN ('failed', 'skipped_no_group', 'processing')
             AND updated_at < NOW() - (
               LEAST($3 * POWER(2, GREATEST(${c.attempt} - 1, 0)), $4) * INTERVAL '1 minute'
             ))
       )
     RETURNING *`,
    [id, maxAttempts, RETRY_BASE_MINUTES, RETRY_MAX_MINUTES]
  );
  return res.rows[0] || null;
}

async function markDestinationSent(id, destination, {
  groupId = null, telegramGroupId = null, messageId = null, matchedBy = null,
} = {}) {
  const c = DEST_COLUMNS[destination];
  if (!c) throw new Error(`Unknown destination: ${destination}`);
  const sets = [
    `${c.status} = 'sent'`,
    `${c.tgGroup} = $2`,
    `${c.tgMsg} = $3`,
    `${c.lastError} = NULL`,
    'updated_at = NOW()',
  ];
  const values = [id, telegramGroupId, messageId];
  if (destination === 'driver') {
    sets.push('group_id = $4', 'matched_by = $5');
    values.push(groupId, matchedBy);
  }
  const res = await query(
    `UPDATE datatruck_document_deliveries SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function markDestinationFailed(id, destination, error) {
  const c = DEST_COLUMNS[destination];
  if (!c) throw new Error(`Unknown destination: ${destination}`);
  const res = await query(
    `UPDATE datatruck_document_deliveries
     SET ${c.status} = 'failed', ${c.lastError} = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, String(error || '').slice(0, 500)]
  );
  return res.rows[0] || null;
}

async function markDestinationSkipped(id, destination, skipStatus, { driverName, unitNumber } = {}) {
  const c = DEST_COLUMNS[destination];
  if (!c) throw new Error(`Unknown destination: ${destination}`);
  const allowed = destination === 'driver' ? DRIVER_SKIP_STATUSES : CENTRAL_SKIP_STATUSES;
  if (!allowed.has(skipStatus)) {
    throw new Error(`Invalid skip status '${skipStatus}' for ${destination} destination`);
  }
  const sets = [`${c.status} = $2`, 'updated_at = NOW()'];
  const values = [id, skipStatus];
  let idx = 3;
  if (destination === 'driver' && (driverName != null || unitNumber != null)) {
    sets.push(`driver_name = COALESCE($${idx++}, driver_name)`, `unit_number = COALESCE($${idx++}, unit_number)`);
    values.push(driverName ?? null, unitNumber ?? null);
  }
  const res = await query(
    `UPDATE datatruck_document_deliveries SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

/**
 * Manual retry: make ONLY the failed destination(s) eligible again (reset to
 * 'pending', clear attempt counter + error). Sent destinations are terminal and
 * left untouched — the successful side is never resent. All SET right-hand sides
 * read the pre-update row, so the CASE guards use the original statuses.
 * @returns {Promise<object|null>} the row, or null when nothing was failed.
 */
async function resetFailedDestinationsForRetry(id) {
  const res = await query(
    `UPDATE datatruck_document_deliveries
     SET status = CASE WHEN status = 'failed' THEN 'pending' ELSE status END,
         attempt_count = CASE WHEN status = 'failed' THEN 0 ELSE attempt_count END,
         last_error = CASE WHEN status = 'failed' THEN NULL ELSE last_error END,
         central_status = CASE WHEN central_status = 'failed' THEN 'pending' ELSE central_status END,
         central_attempt_count = CASE WHEN central_status = 'failed' THEN 0 ELSE central_attempt_count END,
         central_last_error = CASE WHEN central_status = 'failed' THEN NULL ELSE central_last_error END,
         updated_at = NOW()
     WHERE id = $1 AND (status = 'failed' OR central_status = 'failed')
     RETURNING *`,
    [id]
  );
  return res.rows[0] || null;
}

/** Aggregate figures for the admin status panel. */
async function getDeliveryStatusSummary({ maxAttempts = 6 } = {}) {
  const res = await query(
    `SELECT
       MAX(updated_at) FILTER (WHERE status = 'sent' OR central_status = 'sent') AS last_success_at,
       MAX(updated_at) FILTER (WHERE status = 'failed' OR central_status = 'failed') AS last_failure_at,
       COUNT(*) FILTER (WHERE
         (status IN ('pending','processing','failed') AND attempt_count < $1)
         OR (central_status IN ('pending','processing','failed') AND central_attempt_count < $1)
       ) AS pending_retries,
       COUNT(*) FILTER (WHERE status = 'sent' OR central_status = 'sent') AS total_sent,
       COUNT(*) FILTER (WHERE status = 'failed' OR central_status = 'failed') AS total_failed
     FROM datatruck_document_deliveries`,
    [maxAttempts]
  );
  const row = res.rows[0] || {};
  const errRes = await query(
    `SELECT last_error, central_last_error
     FROM datatruck_document_deliveries
     WHERE status = 'failed' OR central_status = 'failed'
     ORDER BY updated_at DESC LIMIT 1`
  );
  const errRow = errRes.rows[0];
  return {
    lastSuccessAt: row.last_success_at || null,
    lastFailureAt: row.last_failure_at || null,
    lastError: errRow ? (errRow.last_error || errRow.central_last_error || null) : null,
    pendingRetries: Number(row.pending_retries || 0),
    totalSent: Number(row.total_sent || 0),
    totalFailed: Number(row.total_failed || 0),
  };
}

/**
 * Display roll-up from the two per-destination statuses. Only destinations that
 * were actually routed count; not-applicable / same-group are ignored unless
 * they are all there is. Pure — exported for the admin view and tests.
 */
function rollupDeliveryStatus(row) {
  if (!row) return 'unknown';
  const inactive = new Set(['skipped_not_applicable', 'skipped_same_group']);
  const active = [row.status, row.central_status].filter((s) => s && !inactive.has(s));
  if (!active.length) {
    if (row.status === 'suppressed_backfill') return 'suppressed_backfill';
    return row.status || 'unknown';
  }
  const has = (s) => active.includes(s);
  const allSent = active.every((s) => s === 'sent');
  if (allSent) return 'sent';
  if (has('sent')) return 'partially_sent';
  if (has('pending') || has('processing')) return 'processing';
  if (has('failed')) return 'failed';
  if (has('skipped_no_group')) return 'missing_driver_group';
  if (has('skipped_unclear')) return 'skipped_unclear';
  if (has('skipped_duplicate')) return 'skipped_duplicate';
  return active[0];
}

module.exports = {
  SERVICE_NAME,
  ensureActivationTime,
  recordBackfillSuppressed,
  listRecentDeliveries,
  // Per-destination helpers for admin-controlled routing.
  upsertDelivery,
  claimDestination,
  markDestinationSent,
  markDestinationFailed,
  markDestinationSkipped,
  resetFailedDestinationsForRetry,
  getDeliveryStatusSummary,
  rollupDeliveryStatus,
  DEST_COLUMNS,
  RETRY_BASE_MINUTES,
  RETRY_MAX_MINUTES,
};
