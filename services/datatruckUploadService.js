/**
 * Upload orchestration for the smart BOL/POD intake pipeline.
 *
 * Ties together: merge the batch into one file (documentMergeService) → hash it
 * → duplicate check (local datatruck_upload_attempts + optional remote list) →
 * DRY-RUN gate → the raw Datatruck upload (datatruckApiService) → record the
 * attempt. Nothing here decides WHETHER to upload — the caller only reaches this
 * after a human confirmed a high/medium-confidence match. This layer's job is to
 * do it safely, once, and never twice.
 *
 * Duplicate prevention (Part 8):
 *   - content hash + (order, document type) checked against our own
 *     datatruck_upload_attempts before any network call, so the same file is
 *     never re-uploaded (covers double confirmations and re-sends).
 *   - the recorded 'uploaded'/'dry_run' row is ALSO what the Datatruck→Telegram
 *     forwarding poller reads to avoid re-forwarding a bot-originated upload
 *     (loop prevention, Part 9).
 *
 * DRY-RUN (Part 10): config.datatruckDocUploadDryRun (default true) short-circuits
 * before the network call, records a 'dry_run' attempt, and returns a
 * "would upload …" result so ops can see the feature working without touching a
 * production load.
 */
const crypto = require('crypto');

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * @param {object} p
 * @param {number|null} p.batchId
 * @param {string|number} p.orderId
 * @param {string} p.loadReference
 * @param {string} p.documentType   bill_of_lading | proof_of_delivery
 * @param {Array<{buffer:Buffer,mimeType?:string,fileName?:string}>} p.files  in order
 * @param {object} [deps]  { config, merge, docs, datatruck, hashBuffer }
 * @returns {Promise<{status:'uploaded'|'dry_run'|'skipped_duplicate'|'failed', ...}>}
 */
async function uploadConfirmedBatch({ batchId = null, orderId, loadReference = null, documentType, files }, deps = {}) {
  const config = deps.config || require('../config/config');
  const merge = deps.merge || require('./documentMergeService');
  const docs = deps.docs || require('../database/telegramDocuments');
  const datatruck = deps.datatruck || require('./datatruckApiService');
  const hashBuffer = deps.hashBuffer || sha256Hex;

  if (!documentType) throw new Error('uploadConfirmedBatch: documentType required.');

  // 1) Merge/unite into the single file Datatruck expects.
  const baseName = `${documentType === 'proof_of_delivery' ? 'POD' : 'BOL'}_${String(loadReference || orderId || 'doc').replace(/[^A-Za-z0-9_-]+/g, '')}`;
  let prepared;
  try {
    prepared = await merge.prepareUpload(files, { baseName });
  } catch (err) {
    await docs.recordUploadAttempt({ batchId, orderId: orderId != null ? String(orderId) : null, loadReference, documentType, status: 'failed' }).catch(() => {});
    return { status: 'failed', stage: 'merge', error: err.message };
  }
  const sha256 = hashBuffer(prepared.buffer);

  // 2) Duplicate check against our own prior attempts (strongest, no network).
  const existing = await docs.findUploadedAttempt({ orderId, documentType, sha256 }).catch(() => null);
  if (existing) {
    await docs.recordUploadAttempt({
      batchId, orderId: orderId != null ? String(orderId) : null, loadReference,
      documentType, sha256, status: 'skipped_duplicate', dryRun: existing.dry_run === true,
    }).catch(() => {});
    return {
      status: 'skipped_duplicate',
      sha256,
      duplicateOf: existing.id,
      message: 'This file appears already uploaded to Datatruck.',
    };
  }

  // 3) DRY-RUN gate — everything except the real upload.
  if (config.datatruckDocUploadDryRun) {
    const attempt = await docs.recordUploadAttempt({
      batchId, orderId: orderId != null ? String(orderId) : null, loadReference,
      documentType, sha256, status: 'dry_run', dryRun: true,
    }).catch(() => null);
    return {
      status: 'dry_run',
      sha256,
      attemptId: attempt?.id || null,
      merged: prepared.merged,
      filename: prepared.filename,
      bytes: prepared.buffer.length,
      message: `Test mode: feature is working. Would upload ${documentType} to Datatruck load ${loadReference || orderId}.`,
    };
  }

  // 4) Live upload.
  const attempt = await docs.recordUploadAttempt({
    batchId, orderId: orderId != null ? String(orderId) : null, loadReference,
    documentType, sha256, status: 'pending', dryRun: false,
  }).catch(() => null);
  try {
    const result = await datatruck.uploadOrderDocument({
      orderId,
      documentType,
      fileBuffer: prepared.buffer,
      filename: prepared.filename,
      mimeType: prepared.mimeType,
    });
    if (attempt?.id) {
      await docs.markUploadAttempt(attempt.id, { status: 'uploaded', datatruckDocumentId: result.documentId }).catch(() => {});
    }
    return {
      status: 'uploaded',
      sha256,
      attemptId: attempt?.id || null,
      documentId: result.documentId,
      fileLink: result.fileLink,
      merged: prepared.merged,
      filename: prepared.filename,
      message: 'Datatruck upload succeeded.',
    };
  } catch (err) {
    const masked = datatruck.maskToken ? datatruck.maskToken(err.message) : err.message;
    if (attempt?.id) {
      await docs.markUploadAttempt(attempt.id, { status: 'failed', errorMessage: masked }).catch(() => {});
    }
    return { status: 'failed', stage: 'upload', error: masked, httpStatus: err.status || null };
  }
}

module.exports = {
  sha256Hex,
  uploadConfirmedBatch,
};
