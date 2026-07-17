/**
 * Database-backed Trailer Department file storage.
 *
 * Bytes go into `trailer_media_blobs` — the same proven approach Route Control
 * uses for screenshots (route_assignment_attachments.file_data). It needs no
 * bucket, no external service, and no configuration, which is precisely why it
 * is the DEFAULT: uploads must work out of the box.
 *
 * Blobs are a separate table from `trailer_media` metadata so ordinary list
 * queries never touch BYTEA. Bytes are read ONLY for an authenticated preview,
 * an authenticated download, or Telegram delivery.
 *
 * Depends only on the pool — no config, no network.
 */
'use strict';

const { query, pool } = require('../../database/pool');

const BACKEND = 'database';

/** Always available: there is nothing to configure. That is the whole point. */
function isConfigured() {
  return true;
}

/**
 * Store bytes and return a descriptor for the metadata row.
 *
 * @param {object} input
 * @param {Buffer} input.bytes
 * @param {string} input.contentType
 * @param {string} input.filename
 * @param {string} input.checksum sha256 of the ORIGINAL upload
 * @param {object} [options]
 * @param {object} [options.client] existing transaction client
 * @param {object} [options.actor]
 * @returns {Promise<{blobId: number, byteSize: number}>}
 */
async function putObject(input, options = {}) {
  const run = options.client ? (t, v) => options.client.query(t, v) : query;
  if (!Buffer.isBuffer(input.bytes) || !input.bytes.length) {
    throw Object.assign(new Error('Cannot store an empty file.'), { status: 400 });
  }
  const res = await run(
    `INSERT INTO trailer_media_blobs
       (mime_type, original_filename, byte_size, checksum_sha256, file_data, uploaded_by_admin_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, byte_size`,
    [
      input.contentType,
      input.filename,
      input.bytes.length,
      input.checksum,
      input.bytes,
      options.actor?.id || null,
    ],
  );
  return { blobId: Number(res.rows[0].id), byteSize: Number(res.rows[0].byte_size) };
}

/**
 * Read bytes back. The ONLY place BYTEA is selected.
 * @returns {Promise<{bytes: Buffer, mimeType: string, filename: string}|null>}
 */
async function getObject(blobId, options = {}) {
  const run = options.client ? (t, v) => options.client.query(t, v) : query;
  const res = await run(
    'SELECT file_data, mime_type, original_filename, checksum_sha256 FROM trailer_media_blobs WHERE id = $1',
    [Number(blobId)],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    bytes: row.file_data,
    mimeType: row.mime_type,
    filename: row.original_filename,
    checksum: row.checksum_sha256,
  };
}

/**
 * Metadata WITHOUT the bytes — for size/type checks and signed-reference
 * versioning, where loading the payload would be pure waste.
 */
async function statObject(blobId, options = {}) {
  const run = options.client ? (t, v) => options.client.query(t, v) : query;
  const res = await run(
    'SELECT id, mime_type, original_filename, byte_size, checksum_sha256 FROM trailer_media_blobs WHERE id = $1',
    [Number(blobId)],
  );
  return res.rows[0] || null;
}

/**
 * Delete orphaned blobs — used when metadata insertion fails after the bytes
 * landed. Never throws: cleanup runs on the failure path and must not mask the
 * error that got us here.
 *
 * A blob still referenced by trailer_media is protected by the FK (RESTRICT),
 * so this can never remove a live file.
 */
async function removeObjects(blobIds, options = {}) {
  const ids = (Array.isArray(blobIds) ? blobIds : [blobIds])
    .map((id) => Number(id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!ids.length) return;
  const run = options.client ? (t, v) => options.client.query(t, v) : query;
  try {
    await run('DELETE FROM trailer_media_blobs WHERE id = ANY($1::bigint[])', [ids]);
  } catch (error) {
    console.error('[TRAILER-STORAGE] orphan blob cleanup failed:', error.message);
  }
}

/** Total bytes stored, for the storage-usage report. */
async function storageUsage() {
  const res = await query(
    'SELECT COUNT(*)::int AS blob_count, COALESCE(SUM(byte_size), 0)::bigint AS total_bytes FROM trailer_media_blobs',
  );
  return { blob_count: res.rows[0].blob_count, total_bytes: Number(res.rows[0].total_bytes) };
}

module.exports = {
  BACKEND,
  isConfigured,
  putObject,
  getObject,
  statObject,
  removeObjects,
  storageUsage,
  pool,
};
