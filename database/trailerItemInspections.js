'use strict';

/**
 * Item-scoped inspections for multi-trailer agreements.
 *
 * The agreement analogue of the legacy saveInspection/completeInspection pair
 * (database/trailerRentals.js), keyed on (rental_item_id, inspection_type)
 * instead of (rental_id, inspection_type). The same invariant holds verbatim:
 * saving answers ALWAYS produces a draft, and completion happens ONLY through
 * completeItemInspection(), which verifies every required field is answered AND
 * the required photo genuinely exists — metadata and bytes — so a failed upload
 * can never leave a completed inspection.
 */

const { pool, query } = require('./pool');
const { insertTrailerAudit } = require('./trailerAudit');

const REQUIRED_INSPECTION_FIELDS = ['overall_condition', 'tires', 'lights', 'doors', 'roof', 'floor', 'exterior', 'interior', 'landing_gear'];

/** The photo an inspection of this type cannot be completed without. */
const REQUIRED_INSPECTION_MEDIA = {
  pickup: 'pickup_condition_photo',
  return: 'return_condition_photo',
};

const INSPECTION_TYPES = ['pickup', 'return', 'damage', 'maintenance'];

function httpError(message, status = 400, code) {
  return Object.assign(new Error(message), { status, code });
}
function actorMeta(actor) {
  return { adminId: actor?.id, roleKeys: actor?.role_keys || actor?.roleKeys || [], ipAddress: actor?.ipAddress || actor?.ip };
}

async function loadItem(client, itemId) {
  const res = await client.query(
    'SELECT id, agreement_id, trailer_id, legacy_rental_id FROM trailer_rental_items WHERE id=$1',
    [Number(itemId)],
  );
  if (!res.rows[0]) throw httpError('Rental item not found.', 404);
  return res.rows[0];
}

/** Existing inspection row for this item+type (or its legacy rental), locked. */
async function findExisting(client, item, type) {
  const byItem = await client.query(
    'SELECT * FROM trailer_inspections WHERE rental_item_id=$1 AND inspection_type=$2 FOR UPDATE',
    [item.id, type],
  );
  if (byItem.rows[0]) return byItem.rows[0];
  if (item.legacy_rental_id) {
    // A backfilled rental may already carry a legacy inspection for this type;
    // adopt that row instead of colliding with its (rental_id, type) uniqueness.
    const byRental = await client.query(
      'SELECT * FROM trailer_inspections WHERE rental_id=$1 AND inspection_type=$2 FOR UPDATE',
      [item.legacy_rental_id, type],
    );
    return byRental.rows[0] || null;
  }
  return null;
}

/**
 * Save inspection answers for an agreement item. ALWAYS as a draft — `completed`
 * in the input is deliberately ignored, exactly like the legacy saveInspection.
 */
async function saveItemInspection(data, actor) {
  if (!INSPECTION_TYPES.includes(data.inspection_type)) throw httpError('Invalid inspection type.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const item = await loadItem(client, data.rental_item_id);
    const before = await findExisting(client, item, data.inspection_type);
    const answers = [data.overall_condition || null, data.tires || null, data.lights || null,
      data.doors || null, data.roof || null, data.floor || null, data.exterior || null,
      data.interior || null, data.landing_gear || null, data.brakes || null,
      data.existing_damage || null, data.new_damage || null, data.missing_equipment || null,
      data.notes || null, actor?.id || null, data.inspected_at || null];
    let row;
    if (before) {
      const res = await client.query(
        `UPDATE trailer_inspections SET
           overall_condition=$2,tires=$3,lights=$4,doors=$5,roof=$6,floor=$7,exterior=$8,
           interior=$9,landing_gear=$10,brakes=$11,existing_damage=$12,new_damage=$13,
           missing_equipment=$14,notes=$15,inspector_admin_id=$16,
           inspected_at=COALESCE($17,inspected_at,NOW()),
           agreement_id=$18,rental_item_id=$19,updated_at=NOW()
         WHERE id=$1 RETURNING *`,
        [before.id, ...answers, item.agreement_id, item.id],
      );
      row = res.rows[0];
    } else {
      const res = await client.query(
        `INSERT INTO trailer_inspections
           (rental_id,agreement_id,rental_item_id,trailer_id,inspection_type,
            overall_condition,tires,lights,doors,roof,floor,exterior,interior,landing_gear,
            brakes,existing_damage,new_damage,missing_equipment,notes,inspector_admin_id,
            inspected_at,completed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                 COALESCE($21,NOW()),FALSE) RETURNING *`,
        [item.legacy_rental_id, item.agreement_id, item.id, item.trailer_id,
          data.inspection_type, ...answers],
      );
      row = res.rows[0];
    }
    await insertTrailerAudit({
      ...actorMeta(actor), action: `inspection.${before ? 'update' : 'create'}`,
      entityType: 'inspection', entityId: row.id, oldValues: before || null, newValues: row,
    }, client);
    await client.query('COMMIT');
    return row;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* original error matters more */ }
    throw error;
  } finally { client.release(); }
}

/**
 * Complete an item inspection — the ONLY path that sets completed=true for an
 * item-scoped inspection. Verifies every required field AND the required photo
 * (metadata + bytes). The photo may be attached via the inspection row OR
 * directly to the rental item, matching how the UI uploads.
 */
async function completeItemInspection(itemId, type, actor) {
  if (!INSPECTION_TYPES.includes(type)) throw httpError('Invalid inspection type.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const item = await loadItem(client, itemId);
    const found = await findExisting(client, item, type);
    if (!found) throw httpError('Save the inspection before completing it.', 404);

    const missing = REQUIRED_INSPECTION_FIELDS.filter((key) => !String(found[key] || '').trim());
    if (missing.length) {
      throw httpError(`Answer every required inspection field first. Missing: ${missing.join(', ')}.`);
    }

    const requiredMedia = REQUIRED_INSPECTION_MEDIA[type];
    if (requiredMedia) {
      // Metadata AND bytes: a row whose blob vanished is not a stored photo.
      const media = await client.query(
        `SELECT m.id
           FROM trailer_media m
           LEFT JOIN trailer_media_blobs b ON b.id = m.blob_id
          WHERE (m.rental_item_id = $1 OR m.inspection_id = $2)
            AND m.media_type = $3
            AND (m.storage_backend = 'supabase' OR (b.id IS NOT NULL AND b.byte_size > 0))
          LIMIT 1`,
        [item.id, found.id, requiredMedia],
      );
      if (!media.rows[0]) {
        throw httpError(
          `At least one ${type} photo must be uploaded before this inspection can be completed.`,
          422,
        );
      }
    }

    const updated = await client.query(
      `UPDATE trailer_inspections SET completed=TRUE,
              inspector_admin_id=COALESCE($2,inspector_admin_id),
              agreement_id=$3, rental_item_id=$4, updated_at=NOW()
        WHERE id=$1 RETURNING *`,
      [found.id, actor?.id || null, item.agreement_id, item.id],
    );
    await insertTrailerAudit({
      ...actorMeta(actor), action: 'inspection.complete', entityType: 'inspection',
      entityId: found.id, oldValues: found, newValues: updated.rows[0],
    }, client);
    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* original error matters more */ }
    throw error;
  } finally { client.release(); }
}

/** Inspections for every item on an agreement, for the detail view. */
async function listAgreementInspections(agreementId) {
  const res = await query(
    `SELECT ins.* FROM trailer_inspections ins
      WHERE ins.agreement_id = $1
         OR ins.rental_item_id IN (SELECT id FROM trailer_rental_items WHERE agreement_id = $1)
      ORDER BY ins.inspected_at`,
    [Number(agreementId)],
  );
  return res.rows;
}

/** Per-item media counts by type, for the detail view checklist state. */
async function summarizeAgreementItemMedia(agreementId) {
  const res = await query(
    `SELECT COALESCE(m.rental_item_id, ins.rental_item_id) AS rental_item_id,
            m.media_type, COUNT(*)::int AS count
       FROM trailer_media m
       LEFT JOIN trailer_inspections ins ON ins.id = m.inspection_id
      WHERE m.rental_item_id IN (SELECT id FROM trailer_rental_items WHERE agreement_id = $1)
         OR ins.rental_item_id IN (SELECT id FROM trailer_rental_items WHERE agreement_id = $1)
      GROUP BY 1, m.media_type
      ORDER BY 1`,
    [Number(agreementId)],
  );
  return res.rows;
}

module.exports = {
  REQUIRED_INSPECTION_FIELDS,
  REQUIRED_INSPECTION_MEDIA,
  saveItemInspection,
  completeItemInspection,
  listAgreementInspections,
  summarizeAgreementItemMedia,
};
