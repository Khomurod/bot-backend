/**
 * Memory-safe multi-image ingest for a complete master-list snapshot.
 *
 * The user uploads the WHOLE official trailer list as many photos. This runs on
 * a small Render instance, so the guiding rule is: never hold more than one
 * image in memory at a time.
 *
 *   - multer writes uploads to TEMPORARY DISK (never memoryStorage).
 *   - images are read, sent to the AI, and released ONE AT A TIME, in order.
 *   - a per-file cap and a total-upload cap are enforced before any AI work.
 *   - temp files are removed on success AND on failure.
 *
 * Contrast with services/trailerImportService.js (the older single-screenshot
 * import), which base64s every image at once — fine for one screenshot, unsafe
 * for a 12-photo fleet list.
 *
 * One AI call PER IMAGE, rather than one call with every image attached: it
 * bounds peak memory, keeps each request small enough to stay well inside the
 * model's limits, lets a single unreadable photo fail without losing the batch,
 * and gives every row a reliable source_image_index for the reviewer.
 */
'use strict';

const fs = require('node:fs/promises');
const config = require('../../config/config');
const { extractRowsFromImage } = require('./extraction');
const { deduplicateRows, detectSnapshotConflicts } = require('./reconcile');

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Upload limits, configurable because fleet sizes differ. */
function limits() {
  return {
    maxImages: Math.max(1, Math.min(50, Number(config.trailerMasterImportMaxImages) || 12)),
    maxBytesPerImage: Math.max(1, Number(config.trailerMasterImportMaxImageBytes) || 8 * 1024 * 1024),
    maxTotalBytes: Math.max(1, Number(config.trailerMasterImportMaxTotalBytes) || 64 * 1024 * 1024),
  };
}

const httpError = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * Validate the upload set BEFORE any image is read into memory or sent to the
 * AI — rejecting early is what keeps a bad upload cheap.
 *
 * @param {Array<{path:string, mimetype:string, size:number, originalname:string}>} files multer disk files
 */
function validateUpload(files) {
  const list = Array.isArray(files) ? files : [];
  const { maxImages, maxBytesPerImage, maxTotalBytes } = limits();

  if (!list.length) throw httpError('Upload at least one photo of the trailer list.');
  if (list.length > maxImages) {
    throw httpError(`Too many images: ${list.length}. This import accepts up to ${maxImages}.`);
  }

  let total = 0;
  for (const file of list) {
    if (!file?.path) throw httpError('Uploads must be written to temporary disk, not held in memory.', 500);
    if (!IMAGE_MIMES.has(String(file.mimetype || '').toLowerCase())) {
      throw httpError(`${file.originalname || 'A file'} is not a JPEG, PNG or WebP image.`);
    }
    if (file.size > maxBytesPerImage) {
      throw httpError(
        `${file.originalname || 'An image'} is ${Math.round(file.size / 1048576)}MB; the limit is `
        + `${Math.round(maxBytesPerImage / 1048576)}MB per image.`,
      );
    }
    total += file.size;
  }
  if (total > maxTotalBytes) {
    throw httpError(
      `The upload totals ${Math.round(total / 1048576)}MB; the limit is ${Math.round(maxTotalBytes / 1048576)}MB. `
      + 'Split the list across two imports.',
    );
  }
  return { imageCount: list.length, totalBytes: total };
}

/** Delete temp files. Never throws — cleanup must not mask a real error. */
async function cleanupTempFiles(files) {
  for (const file of files || []) {
    if (!file?.path) continue;
    try {
      await fs.unlink(file.path);
    } catch (_) {
      // Already gone, or the OS will reap it. Not worth failing the request.
    }
  }
}

/**
 * Read every uploaded image and extract its rows, SEQUENTIALLY.
 *
 * Each image's bytes are read, sent, and dropped before the next is touched, so
 * peak memory is one image — not the whole upload.
 *
 * A per-image failure is recorded and the batch continues: one blurry photo
 * must not discard eleven good ones. The caller decides whether the failures
 * make the snapshot too incomplete to treat as authoritative.
 *
 * @param {Array<object>} files validated multer disk files
 * @returns {Promise<{rows, duplicateGroups, conflicts, rawByImage, failures, imageCount}>}
 */
async function extractSnapshot(files) {
  const list = Array.isArray(files) ? files : [];
  const collected = [];
  const rawByImage = [];
  const failures = [];

  for (let index = 0; index < list.length; index += 1) {
    const file = list[index];
    let bytes = null;
    try {
      bytes = await fs.readFile(file.path);
      const { rows, rawText } = await extractRowsFromImage(
        { bytes, mimeType: String(file.mimetype).toLowerCase() },
        index,
      );
      collected.push(...rows);
      rawByImage.push({ image_index: index, file_name: file.originalname || null, raw_text: rawText, row_count: rows.length });
    } catch (error) {
      // AI unconfigured is fatal for the whole import — retrying per image
      // cannot help, and a partial snapshot must never look complete.
      if (error.status === 503) throw error;
      failures.push({ image_index: index, file_name: file.originalname || null, error: error.message });
    } finally {
      bytes = null; // release before the next image is read
    }
  }

  if (!collected.length && failures.length) {
    throw httpError(`No trailer rows could be read from ${failures.length} image(s).`, 422);
  }

  // Overlapping photos are expected: collapse repeats, then look for identity
  // conflicts across the merged snapshot.
  const { rows, duplicateGroups } = deduplicateRows(collected);
  const conflicts = detectSnapshotConflicts(rows);

  return {
    rows,
    duplicateGroups,
    conflicts,
    rawByImage,
    failures,
    imageCount: list.length,
    extractedRowCount: collected.length,
  };
}

module.exports = {
  validateUpload,
  extractSnapshot,
  cleanupTempFiles,
  limits,
  IMAGE_MIMES,
};
