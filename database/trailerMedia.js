'use strict';

/**
 * Trailer Department media metadata — data access.
 *
 * Metadata only. The BYTES live either in trailer_media_blobs (database
 * backend) or in Supabase, and are reached through services/trailerStorage.
 * Nothing here selects BYTEA, so list queries stay cheap.
 *
 * Every row records the backend that actually stored it (`storage_backend`).
 * Reads follow that value rather than the current configuration, so files
 * written before Supabase was configured keep working forever after it is.
 */

const { query, pool } = require('./pool');

/**
 * Insert a media row from a storage descriptor.
 *
 * Accepts either backend's descriptor: {storageBackend, blobId} for the
 * database, {storageBackend, bucket, objectPath} for Supabase. The CHECK
 * constraint enforces that whichever backend is named can actually find its
 * bytes.
 */
async function createTrailerMedia(data, client = null) {
  const run = client ? client.query.bind(client) : query;
  const backend = data.storageBackend || (data.blobId ? 'database' : 'supabase');
  const res = await run(
    `INSERT INTO trailer_media
      (media_type,trailer_id,rental_id,agreement_id,rental_item_id,inspection_id,invoice_id,payment_id,storage_backend,
       bucket,object_path,preview_object_path,blob_id,preview_blob_id,original_filename,mime_type,
       original_size_bytes,compressed_size_bytes,checksum_sha256,uploaded_by_admin_id,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
    [data.mediaType, data.trailerId || null, data.rentalId || null,
      data.agreementId || null, data.rentalItemId || null, data.inspectionId || null,
      data.invoiceId || null, data.paymentId || null, backend,
      data.bucket || null, data.objectPath || null, data.previewObjectPath || null,
      data.blobId || null, data.previewBlobId || null,
      data.originalFilename, data.mimeType, data.originalSize, data.previewSize || null, data.checksum,
      data.uploadedByAdminId || null, data.notes || null],
  );
  return res.rows[0];
}

async function getTrailerMedia(id, options = {}) {
  const run = options.client ? (t, v) => options.client.query(t, v) : query;
  const res = await run('SELECT * FROM trailer_media WHERE id=$1', [Number(id)]);
  return res.rows[0] || null;
}

async function attachMediaToPayment(mediaId, paymentId, client) {
  const res = await client.query('UPDATE trailer_media SET payment_id=$2 WHERE id=$1 RETURNING *', [mediaId, paymentId]);
  return res.rows[0] || null;
}

/**
 * Media for one inspection. Used to verify required photos genuinely exist
 * before an inspection may be completed.
 */
async function listInspectionMedia(inspectionId, mediaType = null, options = {}) {
  const run = options.client ? (t, v) => options.client.query(t, v) : query;
  const values = [Number(inspectionId)];
  let filter = '';
  if (mediaType) {
    filter = ' AND media_type = $2';
    values.push(mediaType);
  }
  const res = await run(
    `SELECT id, media_type, storage_backend, bucket, object_path, blob_id, preview_blob_id,
            original_filename, mime_type, original_size_bytes, checksum_sha256, created_at
       FROM trailer_media
      WHERE inspection_id = $1${filter}
      ORDER BY created_at`,
    values,
  );
  return res.rows;
}

/**
 * Every document/receipt attached to one invoice — directly (invoice_id) or via
 * one of its payments (payment_id). METADATA ONLY: bytes live in
 * trailer_media_blobs and are never selected in a list. Receipts can be
 * excluded for callers without the receipt permission.
 */
async function listInvoiceMedia(invoiceId, { includeReceipts = true } = {}) {
  const values = [Number(invoiceId)];
  let receiptFilter = '';
  if (!includeReceipts) {
    receiptFilter = " AND m.media_type <> 'payment_receipt'";
  }
  const res = await query(
    `SELECT m.id, m.media_type, m.original_filename, m.mime_type, m.original_size_bytes,
            m.created_at, m.payment_id, a.username AS uploaded_by
       FROM trailer_media m
       LEFT JOIN admins a ON a.id = m.uploaded_by_admin_id
      WHERE (m.invoice_id = $1
             OR m.payment_id IN (SELECT id FROM trailer_payments WHERE invoice_id = $1))
        ${receiptFilter}
      ORDER BY m.created_at DESC`,
    values,
  );
  return res.rows;
}

/**
 * Delete a media row AND its blobs, in one transaction.
 *
 * Only for orphan cleanup on a failed upload — never for a file that is part of
 * a completed inspection or a payment receipt. Blob deletion is second so the
 * FK (RESTRICT) can still protect anything unexpectedly referenced.
 */
async function deleteTrailerMediaWithBlobs(mediaId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const media = await client.query('SELECT * FROM trailer_media WHERE id=$1 FOR UPDATE', [Number(mediaId)]);
    if (!media.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('DELETE FROM trailer_media WHERE id=$1', [Number(mediaId)]);
    const blobIds = [media.rows[0].blob_id, media.rows[0].preview_blob_id].filter(Boolean);
    if (blobIds.length) {
      await client.query('DELETE FROM trailer_media_blobs WHERE id = ANY($1::bigint[])', [blobIds]);
    }
    await client.query('COMMIT');
    return media.rows[0];
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the original error matters more */ }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  createTrailerMedia,
  getTrailerMedia,
  attachMediaToPayment,
  listInspectionMedia,
  listInvoiceMedia,
  deleteTrailerMediaWithBlobs,
};
