/**
 * Screenshot-import staging: batches and their parsed rows.
 *
 * Staging only. Committing an import into the master list is the master-list
 * package's job — see the trailer auto-creation invariant in CLAUDE.md.
 */

const { query } = require('../pool');
const { boundedText: s } = require('../sqlValues');
const { normalizeUnitNumber } = require('../../services/trailerMasterList/normalize');

async function createImportBatch({ uploadedBy = null, fileName = null, parsedCount = 0, errorCount = 0, rawAiResult = null } = {}) {
  const res = await query(
    `INSERT INTO trailer_import_batches (uploaded_by, file_name, status, parsed_count, error_count, raw_ai_result)
     VALUES ($1, $2, 'parsed', $3, $4, $5)
     RETURNING *`,
    [s(uploadedBy, 200), s(fileName, 300), Number(parsedCount) || 0, Number(errorCount) || 0,
      rawAiResult != null ? JSON.stringify(rawAiResult).slice(0, 200000) : null]
  );
  return res.rows[0];
}

async function insertImportRows(batchId, rows = []) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const res = await query(
      `INSERT INTO trailer_import_rows (
         batch_id, unit_number, make, model, mc_number, plate_number,
         type, vin, year, ownership_status, confidence, needs_review, raw_row
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        Number(batchId),
        normalizeUnitNumber(r.unit_number),
        s(r.make, 100), s(r.model, 100), s(r.mc_number, 100), s(r.plate_number, 100),
        s(r.type, 100), s(r.vin, 100), s(r.year, 20), s(r.ownership_status, 100),
        r.confidence != null ? Math.max(0, Math.min(100, Math.round(Number(r.confidence)))) : null,
        Boolean(r.needs_review),
        r.raw_row != null ? JSON.stringify(r.raw_row) : null,
      ]
    );
    out.push(res.rows[0]);
  }
  return out;
}

async function getImportBatch(batchId) {
  const res = await query('SELECT * FROM trailer_import_batches WHERE id = $1', [Number(batchId)]);
  const batch = res.rows[0] || null;
  if (!batch) return null;
  const rowsRes = await query('SELECT * FROM trailer_import_rows WHERE batch_id = $1 ORDER BY id ASC', [Number(batchId)]);
  batch.rows = rowsRes.rows;
  return batch;
}

async function listImportBatches(limit = 50) {
  const res = await query(
    `SELECT * FROM trailer_import_batches ORDER BY created_at DESC LIMIT ${Math.min(200, Math.max(1, Number(limit) || 50))}`
  );
  return res.rows;
}

async function markImportBatchCommitted(batchId) {
  const res = await query(
    `UPDATE trailer_import_batches SET status = 'committed' WHERE id = $1 RETURNING *`,
    [Number(batchId)]
  );
  return res.rows[0] || null;
}


module.exports = {
  createImportBatch,
  insertImportRows,
  getImportBatch,
  listImportBatches,
  markImportBatchCommitted,
};
