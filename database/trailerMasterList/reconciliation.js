/**
 * Master-list reconciliation — applying a reviewer's approved decisions.
 *
 * The ONE place the master list changes as a result of an import. Everything
 * here runs inside a SINGLE transaction: if any decision fails, every
 * master-list change rolls back and the staged import stays intact for another
 * attempt. Half-applied trailer statuses are the failure mode this exists to
 * prevent.
 *
 * Non-destructive by construction:
 *   - a trailer is NEVER hard deleted; archive and merge only change status,
 *     and every event, rental, inspection, invoice and payment survives;
 *   - a merge REASSIGNS history to the survivor and keeps both identifiers as
 *     aliases, so old unit numbers keep resolving;
 *   - a trailer with an active rental cannot be archived or merged until that
 *     conflict is resolved;
 *   - every decision is written to trailer_master_reconciliation_log.
 */
'use strict';

const { pool } = require('../pool');
const { insertTrailerAudit } = require('../trailerAudit');
const { normalizeUnitNumber } = require('../../services/trailerMasterList/normalize');

/**
 * Tables holding a trailer's history, all keyed by trailer_id. A merge moves
 * every one of them to the surviving trailer — miss a table and that history is
 * orphaned on a record no screen will ever show again.
 *
 * trailer_current_status is deliberately ABSENT: it is a derived snapshot with
 * trailer_id as its primary key (so it cannot simply be re-pointed), and it is
 * rebuilt from the events that just moved. It is dropped for the loser instead.
 */
const HISTORY_TABLES = [
  'trailer_events',
  'trailer_pending_instructions',
  'trailer_rentals',
  'trailer_inspections',
  'trailer_rental_movements',
  'trailer_media',
  'trailer_invoices',
  'trailer_payments',
];

const httpError = (message, status = 400) => Object.assign(new Error(message), { status });
const actorMeta = (actor) => ({ adminId: actor?.id, roleKeys: actor?.role_keys || [], ipAddress: actor?.ipAddress });

/** Lock a trailer for update, or fail loudly. */
async function lockTrailer(client, trailerId) {
  const res = await client.query('SELECT * FROM trailers WHERE id = $1 FOR UPDATE', [Number(trailerId)]);
  if (!res.rows[0]) throw httpError(`Trailer ${trailerId} not found.`, 404);
  return res.rows[0];
}

/**
 * Refuse to archive or merge a trailer that is still rented — the physical
 * asset is out with a customer, and hiding it would strand the agreement.
 */
async function assertNoActiveRental(client, trailer, action) {
  const res = await client.query(
    `SELECT agreement_number FROM trailer_rentals
      WHERE trailer_id = $1 AND status IN ('active', 'scheduled')
      LIMIT 1`,
    [trailer.id],
  );
  if (res.rows[0]) {
    throw httpError(
      `${trailer.unit_number} cannot be ${action}: rental ${res.rows[0].agreement_number} is still open. `
      + 'Return or cancel it first.',
      409,
    );
  }
}

/** Append to the permanent reconciliation ledger. */
async function logDecision(client, entry) {
  await client.query(
    `INSERT INTO trailer_master_reconciliation_log
       (batch_id, trailer_id, import_row_id, group_name, decision, previous_unit_number,
        new_unit_number, merged_into_trailer_id, old_values, new_values, reason, decided_by_admin_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      entry.batchId || null,
      entry.trailerId || null,
      entry.importRowId || null,
      entry.group,
      entry.decision,
      entry.previousUnitNumber || null,
      entry.newUnitNumber || null,
      entry.mergedIntoTrailerId || null,
      entry.oldValues ? JSON.stringify(entry.oldValues) : null,
      entry.newValues ? JSON.stringify(entry.newValues) : null,
      entry.reason || null,
      entry.actor?.id || null,
    ],
  );
}

/** Keep a missing trailer on the list, marked verified by a human. */
async function keepVerified(client, decision, context) {
  const trailer = await lockTrailer(client, decision.trailer_id);
  if (!decision.reason) throw httpError(`Keeping ${trailer.unit_number} requires a reason.`);
  const updated = await client.query(
    `UPDATE trailers
        SET master_status = 'active', master_review_reason = $2, master_verified_at = NOW(),
            master_verified_by_admin_id = $3, version = version + 1, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [trailer.id, decision.reason, context.actor?.id || null],
  );
  await logDecision(client, {
    ...context, trailerId: trailer.id, group: 'missing', decision: 'keep_verified',
    oldValues: { master_status: trailer.master_status }, newValues: { master_status: 'active' },
    reason: decision.reason,
  });
  return updated.rows[0];
}

/** Retire a trailer from the active list, keeping every trace of its past. */
async function archive(client, decision, context) {
  const trailer = await lockTrailer(client, decision.trailer_id);
  if (!decision.reason) throw httpError(`Archiving ${trailer.unit_number} requires a reason.`);
  await assertNoActiveRental(client, trailer, 'archived');
  const updated = await client.query(
    `UPDATE trailers
        SET master_status = 'archived', active = FALSE, master_review_reason = $2,
            archived_at = NOW(), archived_by_admin_id = $3, version = version + 1, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [trailer.id, decision.reason, context.actor?.id || null],
  );
  await logDecision(client, {
    ...context, trailerId: trailer.id, group: 'missing', decision: 'archive',
    oldValues: { master_status: trailer.master_status, active: trailer.active },
    newValues: { master_status: 'archived', active: false },
    reason: decision.reason,
  });
  return updated.rows[0];
}

/**
 * Fix an OCR / data-entry mistake in a unit number, keeping the old value as an
 * alias so historical Telegram text and events still resolve.
 */
async function correctUnit(client, decision, context) {
  const trailer = await lockTrailer(client, decision.trailer_id);
  const newUnit = normalizeUnitNumber(decision.new_unit_number);
  if (!newUnit) throw httpError('A corrected unit number is required.');
  if (!decision.reason) throw httpError(`Correcting ${trailer.unit_number} requires a reason.`);
  if (newUnit === trailer.unit_number) throw httpError('The corrected unit number is unchanged.');

  const clash = await client.query('SELECT id FROM trailers WHERE unit_number = $1 AND id <> $2', [newUnit, trailer.id]);
  if (clash.rows[0]) {
    throw httpError(`${newUnit} already belongs to another trailer. Merge them instead.`, 409);
  }
  const aliasClash = await client.query(
    'SELECT id FROM trailer_aliases WHERE alias_unit_number = $1 AND active AND trailer_id <> $2',
    [newUnit, trailer.id],
  );
  if (aliasClash.rows[0]) throw httpError(`${newUnit} is an active alias of another trailer.`, 409);

  const updated = await client.query(
    `UPDATE trailers
        SET unit_number = $2, master_status = 'active', master_review_reason = $3,
            master_verified_at = NOW(), master_verified_by_admin_id = $4,
            version = version + 1, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [trailer.id, newUnit, decision.reason, context.actor?.id || null],
  );

  // The old number becomes an alias: historical event text still says it, and
  // Telegram may keep using it for a while.
  await client.query(
    `INSERT INTO trailer_aliases
       (alias_unit_number, trailer_id, alias_type, reason, source_import_batch_id, created_by_admin_id)
     VALUES ($1,$2,'ocr_correction',$3,$4,$5)
     ON CONFLICT (alias_unit_number) WHERE active DO NOTHING`,
    [trailer.unit_number, trailer.id, decision.reason, context.batchId || null, context.actor?.id || null],
  );

  await logDecision(client, {
    ...context, trailerId: trailer.id, group: 'missing', decision: 'correct_unit',
    previousUnitNumber: trailer.unit_number, newUnitNumber: newUnit,
    oldValues: { unit_number: trailer.unit_number }, newValues: { unit_number: newUnit },
    reason: decision.reason,
  });
  return updated.rows[0];
}

/**
 * Merge a duplicate into a surviving trailer: move ALL history, alias both
 * identifiers to the survivor, and mark the loser merged. Nothing is deleted.
 */
async function merge(client, decision, context) {
  const loserId = Number(decision.trailer_id);
  const winnerId = Number(decision.merge_into_trailer_id);
  if (!winnerId) throw httpError('Merging requires the trailer to merge into.');
  if (loserId === winnerId) throw httpError('A trailer cannot be merged into itself.');
  if (!decision.reason) throw httpError('Merging requires a reason.');

  // Lock in a stable order so two concurrent merges cannot deadlock.
  const [first, second] = loserId < winnerId ? [loserId, winnerId] : [winnerId, loserId];
  await lockTrailer(client, first);
  await lockTrailer(client, second);
  const loser = await lockTrailer(client, loserId);
  const winner = await lockTrailer(client, winnerId);

  if (winner.master_status === 'merged') {
    throw httpError(`${winner.unit_number} was itself merged away; merge into the surviving trailer instead.`, 409);
  }
  await assertNoActiveRental(client, loser, 'merged');

  // Move every history table to the survivor.
  const moved = {};
  for (const table of HISTORY_TABLES) {
    const res = await client.query(`UPDATE ${table} SET trailer_id = $2 WHERE trailer_id = $1`, [loserId, winnerId]);
    if (res.rowCount) moved[table] = res.rowCount;
  }
  // Derived snapshot, not history: the events it summarized now belong to the
  // winner, so the loser's row is meaningless and its PK blocks re-pointing.
  await client.query('DELETE FROM trailer_current_status WHERE trailer_id = $1', [loserId]);
  // Existing aliases of the loser must follow it to the survivor.
  await client.query('UPDATE trailer_aliases SET trailer_id = $2 WHERE trailer_id = $1', [loserId, winnerId]);
  await client.query(
    'UPDATE trailer_unmatched_mentions SET linked_trailer_id = $2 WHERE linked_trailer_id = $1',
    [loserId, winnerId],
  );

  // The loser's number keeps resolving — to the survivor.
  await client.query(
    `INSERT INTO trailer_aliases
       (alias_unit_number, trailer_id, alias_type, reason, source_import_batch_id, created_by_admin_id)
     VALUES ($1,$2,'merge',$3,$4,$5)
     ON CONFLICT (alias_unit_number) WHERE active DO NOTHING`,
    [loser.unit_number, winnerId, decision.reason, context.batchId || null, context.actor?.id || null],
  );

  const merged = await client.query(
    `UPDATE trailers
        SET master_status = 'merged', active = FALSE, merged_into_trailer_id = $2,
            master_review_reason = $3, master_verified_at = NOW(), master_verified_by_admin_id = $4,
            version = version + 1, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [loserId, winnerId, decision.reason, context.actor?.id || null],
  );

  await logDecision(client, {
    ...context, trailerId: loserId, group: 'missing', decision: 'merge',
    previousUnitNumber: loser.unit_number, newUnitNumber: winner.unit_number,
    mergedIntoTrailerId: winnerId,
    oldValues: { master_status: loser.master_status },
    newValues: { master_status: 'merged', merged_into_trailer_id: winnerId, moved },
    reason: decision.reason,
  });
  return merged.rows[0];
}

/** Create a trailer approved from the snapshot's "new" group. */
async function createApproved(client, decision, context) {
  const unit = normalizeUnitNumber(decision.unit_number);
  if (!unit) throw httpError('An approved trailer needs a unit number.');
  const clash = await client.query('SELECT id FROM trailers WHERE unit_number = $1', [unit]);
  if (clash.rows[0]) throw httpError(`${unit} already exists on the master list.`, 409);

  const fields = ['make', 'model', 'mc_number', 'plate_number', 'type', 'vin', 'year', 'ownership_status'];
  const cols = ['unit_number', 'source', 'master_source', 'master_status', 'master_import_batch_id',
    'master_verified_at', 'master_verified_by_admin_id', 'created_by_admin_id'];
  const values = [unit, 'screenshot_import', 'approved_import', 'active', context.batchId || null,
    new Date(), context.actor?.id || null, context.actor?.id || null];
  for (const field of fields) {
    const value = decision[field] == null || String(decision[field]).trim() === '' ? null : String(decision[field]).trim();
    if (value != null) { cols.push(field); values.push(value); }
  }
  const created = await client.query(
    `INSERT INTO trailers (${cols.join(', ')})
     VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    values,
  );
  await logDecision(client, {
    ...context, trailerId: created.rows[0].id, importRowId: decision.import_row_id,
    group: 'new', decision: 'create', newUnitNumber: unit, newValues: created.rows[0],
    reason: decision.reason || 'Approved from master-list import.',
  });
  return created.rows[0];
}

/**
 * Apply reviewed field changes to a matched trailer.
 * A BLANK value is never applied: the caller has already filtered the changes a
 * human accepted, and an unread column is not evidence the data is gone.
 */
async function updateMatched(client, decision, context) {
  const trailer = await lockTrailer(client, decision.trailer_id);
  const fields = ['make', 'model', 'mc_number', 'plate_number', 'type', 'vin', 'year', 'ownership_status'];
  const sets = [];
  const values = [];
  let i = 2;
  const applied = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(decision, field)) continue;
    const value = decision[field] == null || String(decision[field]).trim() === '' ? null : String(decision[field]).trim();
    if (value == null) continue;
    sets.push(`${field} = $${i++}`);
    values.push(value);
    applied[field] = value;
  }
  sets.push(`master_import_batch_id = $${i++}`); values.push(context.batchId || null);
  sets.push(`master_verified_at = NOW(), master_verified_by_admin_id = $${i++}`);
  values.push(context.actor?.id || null);
  sets.push('version = version + 1, updated_at = NOW()');

  const updated = await client.query(
    `UPDATE trailers SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    [trailer.id, ...values],
  );
  await logDecision(client, {
    ...context, trailerId: trailer.id, importRowId: decision.import_row_id,
    group: 'matched', decision: 'update',
    oldValues: trailer, newValues: applied, reason: decision.reason || null,
  });
  return updated.rows[0];
}

const HANDLERS = {
  keep_verified: keepVerified,
  archive,
  correct_unit: correctUnit,
  merge,
  create: createApproved,
  update: updateMatched,
};

/**
 * Apply every approved decision from one reconciliation, atomically.
 *
 * @param {number} batchId the confirmed master_snapshot batch
 * @param {Array<object>} decisions [{ decision, trailer_id?, ... }]
 * @param {object} [options]
 * @param {object} [options.actor]
 * @returns {Promise<{applied: number, results: Array, batch: object}>}
 */
async function applyReconciliation(batchId, decisions, options = {}) {
  const list = Array.isArray(decisions) ? decisions : [];
  if (!list.length) throw httpError('There are no decisions to apply.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const batch = await client.query(
      `SELECT * FROM trailer_import_batches WHERE id = $1 AND import_kind = 'master_snapshot' FOR UPDATE`,
      [Number(batchId)],
    );
    if (!batch.rows[0]) throw httpError('Master-list import not found.', 404);
    if (!batch.rows[0].confirmed_at) {
      throw httpError('Confirm this import represents the complete official trailer list first.', 409);
    }
    if (batch.rows[0].status === 'reconciled') {
      throw httpError('This import was already reconciled.', 409);
    }

    const context = { batchId: Number(batchId), actor: options.actor };
    const results = [];
    for (const decision of list) {
      const handler = HANDLERS[decision.decision];
      if (!handler) throw httpError(`Unknown reconciliation decision: ${decision.decision}`);
      results.push({ decision: decision.decision, trailer: await handler(client, decision, context) });
    }

    const reconciled = await client.query(
      `UPDATE trailer_import_batches SET status = 'reconciled', reconciled_at = NOW()
        WHERE id = $1 RETURNING *`,
      [Number(batchId)],
    );

    await insertTrailerAudit({
      ...actorMeta(options.actor),
      action: 'master_list.reconcile',
      entityType: 'import_batch',
      entityId: String(batchId),
      newValues: { applied: results.length, decisions: list.map((d) => d.decision) },
    }, client);

    await client.query('COMMIT');
    return { applied: results.length, results, batch: reconciled.rows[0] };
  } catch (error) {
    // Roll back every master-list change; the staged import survives for a retry.
    try { await client.query('ROLLBACK'); } catch (_) { /* the original error matters more */ }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { applyReconciliation, HISTORY_TABLES };
