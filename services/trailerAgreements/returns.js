/**
 * Item return + invoicing (transactional).
 *
 * Returning one trailer on an agreement is independent of the other items. This
 * marks the item returned, frees the trailer (unless damage forces a non-
 * available status), records a movement, computes the item's invoice line(s)
 * from its billable window plus any damage/cleaning/late/other charges from the
 * return dialog, and re-derives the agreement status — all atomically.
 *
 * Charges and pricing come from the pure services/trailerPricing helpers so the
 * math is testable in isolation and matches legacy day counting.
 */
'use strict';

const { withTxn, httpError } = require('./lifecycle');
const agreementsDb = require('../../database/trailerAgreements/agreements');
const itemsDb = require('../../database/trailerAgreements/items');
const { buildItemLine } = require('../trailerPricing/invoiceBuilder');
const { insertTrailerAudit } = require('../../database/trailerAudit');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/**
 * A completed return inspection with a photo backed by real bytes — the return
 * mirror of validateItemPickupInspection. A trailer cannot flip to returned
 * without evidence of the state it came back in.
 */
async function validateItemReturnInspection(client, itemId) {
  const res = await client.query(
    `SELECT ins.id
       FROM trailer_inspections ins
      WHERE ins.rental_item_id = $1 AND ins.inspection_type = 'return' AND ins.completed = TRUE
        AND EXISTS (
          SELECT 1 FROM trailer_media m
          LEFT JOIN trailer_media_blobs b ON b.id = m.blob_id
          WHERE (m.rental_item_id = $1 OR m.inspection_id = ins.id)
            AND m.media_type = 'return_condition_photo'
            AND (m.storage_backend = 'supabase' OR (b.id IS NOT NULL AND b.byte_size > 0))
        )
      LIMIT 1`,
    [Number(itemId)],
  );
  if (!res.rows[0]) {
    throw httpError(
      'A completed return inspection with a stored return photo is required before this trailer can be returned.',
      409, 'RETURN_INSPECTION_INCOMPLETE',
    );
  }
  return res.rows[0];
}

/** New damage needs a description and at least one damage photo for the item. */
async function validateDamageEvidence(client, itemId, input) {
  if (!String(input.description || input.damage_description || '').trim()) {
    throw httpError('Describe the new damage before returning this trailer.', 422, 'DAMAGE_EVIDENCE_REQUIRED');
  }
  const photo = await client.query(
    `SELECT m.id FROM trailer_media m
      LEFT JOIN trailer_inspections ins ON ins.id = m.inspection_id
      WHERE (m.rental_item_id = $1 OR ins.rental_item_id = $1)
        AND m.media_type = 'damage_photo'
      LIMIT 1`,
    [Number(itemId)],
  );
  if (!photo.rows[0]) {
    throw httpError('Add at least one photo of the new damage before returning this trailer.', 422, 'DAMAGE_EVIDENCE_REQUIRED');
  }
}

async function returnItem(agreementId, itemId, input = {}, actor = {}, { requireInspection = true } = {}) {
  return withTxn(async (client) => {
    const itemRes = await client.query(
      'SELECT * FROM trailer_rental_items WHERE id = $1 AND agreement_id = $2 FOR UPDATE',
      [Number(itemId), Number(agreementId)],
    );
    const item = itemRes.rows[0];
    if (!item) throw httpError('Item not found.', 404);
    if (item.item_status !== 'active') {
      throw httpError('Only an active trailer can be returned.', 409, 'ITEM_NOT_ACTIVE');
    }
    const actualReturn = input.actual_return_at ? new Date(input.actual_return_at) : new Date();
    const hasDamage = Number(input.damage_charge || 0) > 0 || input.new_damage;
    const trailerStatus = input.trailer_status
      || (hasDamage ? 'held_damage' : 'available');
    if (hasDamage && trailerStatus === 'available') {
      throw httpError('A trailer with new damage cannot be marked available.', 422, 'DAMAGE_STATUS_REQUIRED');
    }
    if (requireInspection) {
      await validateItemReturnInspection(client, itemId);
      if (hasDamage) await validateDamageEvidence(client, itemId, input);
    }

    const agreement = await agreementsDb.getAgreementById(agreementId, client);
    const timezone = item.billing_timezone_override || agreement.billing_timezone || 'America/Chicago';
    const window = { startAt: item.actual_pickup_at || item.scheduled_pickup_at, endAt: actualReturn, timezone };
    const line = buildItemLine(item, window, {
      damage_charge: input.damage_charge, cleaning_charge: input.cleaning_charge,
      late_fee: input.late_fee, other_charge: input.other_charge,
      description: input.description,
    });

    // Persist the charges entered at return so invoice generation — combined or
    // separate, possibly days later — bills them instead of silently losing them.
    const returnCharges = {};
    for (const key of ['damage_charge', 'cleaning_charge', 'late_fee', 'other_charge', 'discount', 'deposit_allocation_used']) {
      const value = round2(input[key]);
      if (value) returnCharges[key] = value;
    }
    if (String(input.description || '').trim()) returnCharges.description = String(input.description).trim();

    const updated = await itemsDb.setItemStatus(itemId, 'returned', {
      actual_return_at: actualReturn,
      return_location: input.return_location || null,
      return_lat: input.return_lat ?? null,
      return_lng: input.return_lng ?? null,
      return_charges: Object.keys(returnCharges).length ? JSON.stringify(returnCharges) : null,
      updated_by_admin_id: actor.id || null,
    }, client, input.version);
    await client.query(
      'UPDATE trailers SET physical_status = $2, updated_by_admin_id = $3, updated_at = NOW() WHERE id = $1',
      [item.trailer_id, trailerStatus, actor.id || null],
    );
    await client.query(
      `INSERT INTO trailer_rental_movements
         (trailer_id, agreement_id, rental_item_id, movement_type, to_location, to_lat, to_lng,
          event_at, employee_admin_id, source)
       VALUES ($1, $2, $3, 'rental_return', $4, $5, $6, $7, $8, 'agreement')`,
      [item.trailer_id, Number(agreementId), item.id, input.return_location || null,
        input.return_lat ?? null, input.return_lng ?? null, actualReturn, actor.id || null],
    );
    await insertTrailerAudit({
      adminId: actor.id || null, roleKeys: actor.roleKeys, ipAddress: actor.ip,
      action: 'agreement.item.return', entityType: 'rental_item', entityId: item.id,
      oldValues: item, newValues: updated,
    }, client);

    const refreshed = await agreementsDb.refreshAgreementStatus(agreementId, client);
    return { agreement: refreshed, item: updated, invoiceLine: line };
  });
}

module.exports = { returnItem, validateItemReturnInspection };
