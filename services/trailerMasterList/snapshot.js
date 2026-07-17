/**
 * Master-list snapshot orchestration.
 *
 * Ties the pieces together for the routes layer, keeping business logic out of
 * the route file:
 *
 *   stageSnapshot(files)        upload -> validate -> extract (one image at a
 *                               time, from temp disk) -> STAGE. Never touches
 *                               `trailers`.
 *   buildReconciliation(batch)  staged snapshot x current master list -> the
 *                               four review groups. Read-only.
 *
 * Applying the reviewer's decisions lives in
 * database/trailerMasterList/reconciliation.js, where it can be transactional.
 */
'use strict';

const db = require('../../database/db');
const { validateUpload, extractSnapshot, cleanupTempFiles } = require('./imageIngest');
const { reconcileSnapshot } = require('./reconcile');

/**
 * Turn an upload into a staged snapshot awaiting review.
 *
 * Temp files are ALWAYS cleaned up, success or failure — the spec is explicit,
 * and a failed import must not leave megabytes of photos on a small instance.
 *
 * @param {Array<object>} files multer disk-storage files
 * @param {object} [options]
 * @param {object} [options.actor]
 * @returns {Promise<{batch, rows, summary}>}
 */
async function stageSnapshot(files, options = {}) {
  try {
    const { imageCount, totalBytes } = validateUpload(files);
    const extracted = await extractSnapshot(files);

    const { batch, rows } = await db.createMasterSnapshotBatch({
      rows: extracted.rows,
      image_count: imageCount,
      file_name: files.length === 1 ? files[0].originalname : `${files.length} images`,
      duplicate_count: extracted.duplicateGroups.length,
      conflict_count: extracted.conflicts.length,
      raw_by_image: extracted.rawByImage,
      failures: extracted.failures,
      duplicate_groups: extracted.duplicateGroups,
      conflicts: extracted.conflicts,
      extracted_row_count: extracted.extractedRowCount,
    }, options);

    return {
      batch,
      rows,
      summary: {
        image_count: imageCount,
        total_bytes: totalBytes,
        extracted_rows: extracted.extractedRowCount,
        unique_trailers: extracted.rows.length,
        duplicate_groups: extracted.duplicateGroups.length,
        conflicts: extracted.conflicts.length,
        needs_review: rows.filter((r) => r.needs_review).length,
        // A failed image means the snapshot may NOT be the complete list. The
        // reviewer has to know before confirming it as authoritative.
        failed_images: extracted.failures,
      },
    };
  } finally {
    await cleanupTempFiles(files);
  }
}

/**
 * Compare a staged snapshot against the current master list.
 *
 * Read-only: it decides, it does not write. Archived and merged trailers are
 * excluded from the comparison set — they already left the active list, so
 * their absence from the snapshot is expected, not a finding.
 *
 * @param {number} batchId
 * @returns {Promise<object>} the four groups + summary + batch
 */
async function buildReconciliation(batchId) {
  const batch = await db.getImportBatchById(batchId);
  if (!batch || batch.import_kind !== 'master_snapshot') {
    throw Object.assign(new Error('Master-list import not found.'), { status: 404 });
  }

  const [stagedRows, trailers, aliases] = await Promise.all([
    db.listImportRows(batchId),
    db.listTrailers({ include_unofficial: true }),
    db.listActiveAliases(),
  ]);

  const snapshotRows = stagedRows.map((row) => ({
    import_row_id: row.id,
    unit_number: row.normalized_unit_number || row.unit_number,
    make: row.make,
    model: row.model,
    mc_number: row.mc_number,
    plate_number: row.plate_number,
    type: row.type,
    vin: row.vin,
    year: row.year,
    ownership_status: row.ownership_status,
    confidence: row.confidence,
    field_confidence: row.field_confidence || {},
    needs_review: row.needs_review,
    conflict_details: row.conflict_details,
    source_image_index: row.source_image_index,
  }));

  const groups = reconcileSnapshot({
    snapshotRows,
    trailers: trailers.filter((t) => t.master_status !== 'archived' && t.master_status !== 'merged'),
    aliases,
  });

  return { batch, ...groups };
}

module.exports = { stageSnapshot, buildReconciliation };
