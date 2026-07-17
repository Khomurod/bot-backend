/**
 * Master-list import staging — data access.
 *
 * Reuses the existing trailer_import_batches / trailer_import_rows tables
 * (import_kind='master_snapshot') so the screenshot-import history and its raw
 * AI audit trail are preserved rather than forked into a parallel schema.
 *
 * The staging contract: AI extraction NEVER touches `trailers`. Rows live here
 * until an authorized employee reviews and confirms them, and only then does
 * ../trailerMasterList/reconciliation.js apply the approved decisions.
 */
'use strict';

const { query, pool } = require('../pool');

const STAGED_ROW_FIELDS = [
  'unit_number', 'make', 'model', 'mc_number', 'plate_number',
  'type', 'vin', 'year', 'ownership_status',
];

/**
 * Open a staged snapshot batch and store its rows in ONE transaction, so a
 * half-written snapshot can never be mistaken for a complete official list.
 *
 * @param {object} input
 * @param {Array<object>} input.rows deduplicated extracted rows
 * @param {object} [options]
 * @param {object} [options.actor]
 * @returns {Promise<{batch: object, rows: Array<object>}>}
 */
async function createMasterSnapshotBatch(input, options = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = Array.isArray(input.rows) ? input.rows : [];
    const needsReview = rows.filter((r) => r.needs_review).length;

    const batch = await client.query(
      `INSERT INTO trailer_import_batches
         (uploaded_by, uploaded_by_admin_id, file_name, status, import_kind, is_complete_snapshot,
          image_count, parsed_count, error_count, duplicate_count, conflict_count, raw_ai_result)
       VALUES ($1,$2,$3,'staged','master_snapshot',TRUE,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        options.actor?.username || null,
        options.actor?.id || null,
        input.file_name || null,
        Number(input.image_count) || 0,
        rows.length,
        needsReview,
        Number(input.duplicate_count) || 0,
        Number(input.conflict_count) || 0,
        JSON.stringify({
          raw_by_image: input.raw_by_image || [],
          failures: input.failures || [],
          duplicate_groups: input.duplicate_groups || [],
          conflicts: input.conflicts || [],
          extracted_row_count: input.extracted_row_count ?? rows.length,
        }),
      ],
    );

    const stored = [];
    for (const row of rows) {
      const res = await client.query(
        `INSERT INTO trailer_import_rows
           (batch_id, unit_number, normalized_unit_number, make, model, mc_number, plate_number,
            type, vin, year, ownership_status, confidence, needs_review, field_confidence,
            conflict_details, duplicate_group_key, source_image_index, raw_row)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [
          batch.rows[0].id,
          row.unit_number || null,
          row.unit_number || null,
          row.make || null,
          row.model || null,
          row.mc_number || null,
          row.plate_number || null,
          row.type || null,
          row.vin || null,
          row.year || null,
          row.ownership_status || null,
          row.confidence ?? null,
          Boolean(row.needs_review),
          row.field_confidence ? JSON.stringify(row.field_confidence) : null,
          row.conflict_details ? JSON.stringify(row.conflict_details) : null,
          row.duplicate_group_key || null,
          row.source_image_index ?? null,
          row.raw_row ? JSON.stringify(row.raw_row) : null,
        ],
      );
      stored.push(res.rows[0]);
    }

    await client.query('COMMIT');
    return { batch: batch.rows[0], rows: stored };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the original error matters more */ }
    throw error;
  } finally {
    client.release();
  }
}

async function getImportBatchById(id, options = {}) {
  const run = options.client ? (t, v) => options.client.query(t, v) : query;
  const res = await run('SELECT * FROM trailer_import_batches WHERE id = $1', [Number(id)]);
  return res.rows[0] || null;
}

/** Staged rows for a batch, in reading order (image, then unit). */
async function listImportRows(batchId, options = {}) {
  const run = options.client ? (t, v) => options.client.query(t, v) : query;
  const res = await run(
    `SELECT * FROM trailer_import_rows
      WHERE batch_id = $1
      ORDER BY source_image_index NULLS LAST, unit_number`,
    [Number(batchId)],
  );
  return res.rows;
}

/** Paginated batch list. Excludes raw_ai_result — it is large and unused here. */
async function listImportBatches(filters = {}) {
  const where = [];
  const values = [];
  let i = 1;
  if (filters.import_kind) {
    where.push(`import_kind = $${i++}`);
    values.push(String(filters.import_kind));
  }
  if (filters.status) {
    where.push(`status = $${i++}`);
    values.push(String(filters.status));
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = Math.min(100, Math.max(1, Number(filters.page_size) || 25));
  const page = Math.max(1, Number(filters.page) || 1);

  const [rows, total] = await Promise.all([
    query(
      `SELECT id, uploaded_by, uploaded_by_admin_id, file_name, status, import_kind,
              is_complete_snapshot, image_count, parsed_count, error_count, duplicate_count,
              conflict_count, confirmed_at, reconciled_at, created_at
         FROM trailer_import_batches ${whereClause}
        ORDER BY created_at DESC, id DESC
        LIMIT $${i++} OFFSET $${i++}`,
      [...values, pageSize, (page - 1) * pageSize],
    ),
    query(`SELECT COUNT(*)::int AS count FROM trailer_import_batches ${whereClause}`, values),
  ]);
  return { rows: rows.rows, total: total.rows[0].count, page, page_size: pageSize };
}

/**
 * Record a reviewer's edits to a staged row before approval.
 * Staging only — this never touches `trailers`.
 */
async function updateImportRow(rowId, edits, options = {}) {
  const run = options.client ? (t, v) => options.client.query(t, v) : query;
  const sets = [];
  const values = [];
  let i = 1;
  for (const field of STAGED_ROW_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(edits, field)) continue;
    const value = edits[field] == null || String(edits[field]).trim() === '' ? null : String(edits[field]).trim();
    sets.push(`${field} = $${i++}`);
    values.push(value);
    if (field === 'unit_number') {
      sets.push(`normalized_unit_number = $${i++}`);
      values.push(value ? value.toUpperCase().replace(/[#\s]+/g, '') : null);
    }
  }
  if (edits.reviewer_action !== undefined) {
    sets.push(`reviewer_action = $${i++}`);
    values.push(edits.reviewer_action || null);
  }
  if (!sets.length) return null;
  sets.push(`reviewer_admin_id = $${i++}`);
  values.push(options.actor?.id || null);
  sets.push('reviewed_at = NOW()');
  values.push(Number(rowId));

  const res = await run(`UPDATE trailer_import_rows SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, values);
  return res.rows[0] || null;
}

/**
 * Mark the snapshot confirmed as the complete official list.
 *
 * Separate from reconciliation on purpose: the spec requires explicit
 * confirmation that these photos ARE the whole list before anything is
 * compared against the database and trailers start going missing.
 */
async function confirmSnapshotBatch(batchId, options = {}) {
  const run = options.client ? (t, v) => options.client.query(t, v) : query;
  const res = await run(
    `UPDATE trailer_import_batches
        SET confirmed_by_admin_id = $2, confirmed_at = NOW()
      WHERE id = $1 AND import_kind = 'master_snapshot' AND status = 'staged'
      RETURNING *`,
    [Number(batchId), options.actor?.id || null],
  );
  if (!res.rows[0]) {
    throw Object.assign(new Error('This import is not a staged master-list snapshot.'), { status: 409 });
  }
  return res.rows[0];
}

/** Close out a batch after its reconciliation committed. */
async function markBatchReconciled(batchId, options = {}) {
  const run = options.client ? (t, v) => options.client.query(t, v) : query;
  const res = await run(
    `UPDATE trailer_import_batches SET status = 'reconciled', reconciled_at = NOW()
      WHERE id = $1 RETURNING *`,
    [Number(batchId)],
  );
  return res.rows[0] || null;
}

module.exports = {
  createMasterSnapshotBatch,
  getImportBatchById,
  listImportRows,
  listImportBatches,
  updateImportRow,
  confirmSnapshotBatch,
  markBatchReconciled,
  STAGED_ROW_FIELDS,
};
