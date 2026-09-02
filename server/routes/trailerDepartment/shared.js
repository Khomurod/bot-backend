/**
 * Request-handling helpers shared by every Trailer Department sub-router:
 * the upload sink, the actor/permission accessors, CSV delivery, and the
 * two-object (original + preview) storage write.
 *
 * These are the pieces each domain module needs and none of them owns. They
 * live here rather than in services/ because each one is about an Express
 * request — `actor()` reads req.admin and req.ip, `can()` reads the permission
 * set the auth middleware attached — so they belong to the route layer.
 *
 * Split out of server/routes/trailerDepartmentRoutes.js.
 */
'use strict';

const multer = require('multer');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const storage = require('../../../services/trailerStorageService');
const { processTrailerUpload, safeFilename } = require('../../../services/trailerImageService');
const { toCsv } = require('../csvSafe');

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => cb(
      null,
      `trailer-${crypto.randomUUID()}-${safeFilename(file.originalname)}`,
    ),
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 10 },
});

/** Route wrapper that funnels a rejected promise into Express's error handler. */
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Who is acting, for the audit trail. */
function actor(req) {
  return { ...req.admin, ipAddress: req.ip };
}

/**
 * Whether the caller holds one EXTRA permission beyond the route's guard.
 *
 * requirePermission() gates the endpoint; this answers the finer questions
 * inside a handler — may this admin archive rather than merely edit, see
 * receipt rows, record a payment with no receipt, confirm an overpayment.
 */
function can(req, permission) {
  return new Set(req.admin?.permissions || []).has(permission);
}

// csvCell/toCsv are formula-injection-safe (see ../csvSafe).
function sendCsv(res, name, rows) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${name}.csv"`);
  res.send(toCsv(rows));
}

function objectNamespace(mediaType) {
  if (mediaType === 'payment_receipt') return 'payment-receipts';
  if (mediaType === 'agreement_document') return 'agreements';
  if (mediaType === 'invoice_document') return 'invoices';
  return 'condition-photos';
}

/**
 * Validate and store one upload with whichever backend is active.
 *
 * Storage no longer requires Supabase: with no bucket configured the bytes go
 * into Postgres (services/trailerStorage), so photo upload — and therefore
 * pickup activation, which requires a photo — works out of the box.
 *
 * The returned descriptor carries `uploaded` so a caller whose metadata insert
 * fails can hand it straight back to storage.removeObjects and leave nothing
 * orphaned.
 */
async function storeFile(file, mediaType, entityKey, options = {}) {
  const processed = await processTrailerUpload(file);
  const base = `${objectNamespace(mediaType)}/${entityKey}/${crypto.randomUUID()}`;
  const extension = path.extname(processed.originalFilename).toLowerCase()
    || (processed.mimeType === 'application/pdf' ? '.pdf' : '.bin');
  const uploaded = [];
  try {
    const original = await storage.putObject({
      bytes: processed.original,
      contentType: processed.mimeType,
      filename: processed.originalFilename,
      checksum: processed.checksum,
      objectPath: `${base}/original${extension}`,
    }, options);
    uploaded.push(original);

    let preview = null;
    if (processed.preview) {
      preview = await storage.putObject({
        bytes: processed.preview,
        contentType: 'image/webp',
        filename: 'preview.webp',
        checksum: processed.checksum,
        objectPath: `${base}/preview.webp`,
      }, options);
      uploaded.push(preview);
    }

    return {
      storageBackend: original.storageBackend,
      bucket: original.bucket || null,
      objectPath: original.objectPath || null,
      blobId: original.blobId || null,
      previewObjectPath: preview?.objectPath || null,
      previewBlobId: preview?.blobId || null,
      originalFilename: processed.originalFilename,
      mimeType: processed.mimeType,
      originalSize: processed.originalSize,
      previewSize: processed.previewSize,
      checksum: processed.checksum,
      uploaded,
    };
  } catch (e) {
    await storage.removeObjects(uploaded);
    throw e;
  }
}

/** Drop multer's temp files; a failure to unlink must never fail the request. */
async function cleanupFiles(files) {
  for (const file of files || []) {
    try {
      await fs.unlink(file.path);
    } catch (_) { /* already gone, or never written */ }
  }
}

module.exports = {
  upload, asyncRoute, actor, can, sendCsv, objectNamespace, storeFile, cleanupFiles,
};
