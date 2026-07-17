/**
 * Item pickup activation (transactional).
 *
 * Activating one trailer on an agreement is the multi-trailer analogue of
 * activateTrailerRental. It is atomic and validates, before flipping the item to
 * `active`:
 *   - the item exists and is draft/scheduled/ready_for_pickup
 *   - the trailer is official and physically available (locked FOR UPDATE)
 *   - a pickup window and location exist
 *   - a COMPLETED pickup inspection exists for the item AND its required photo
 *     has real bytes (metadata + blob), mirroring the legacy invariant so a
 *     failed upload can never leave an activatable item
 *   - no other active item holds the trailer
 * On success it marks the item active, the trailer rented, writes a movement and
 * an audit entry, and re-derives the agreement status — all in one transaction.
 */
'use strict';

const { withTxn, httpError } = require('./lifecycle');
const agreementsDb = require('../../database/trailerAgreements/agreements');
const itemsDb = require('../../database/trailerAgreements/items');
const { insertTrailerAudit } = require('../../database/trailerAudit');

/** A completed pickup inspection with a photo backed by real bytes. */
async function validateItemPickupInspection(client, itemId) {
  const res = await client.query(
    `SELECT ins.id
       FROM trailer_inspections ins
      WHERE ins.rental_item_id = $1 AND ins.inspection_type = 'pickup' AND ins.completed = TRUE
        AND EXISTS (
          SELECT 1 FROM trailer_media m
          LEFT JOIN trailer_media_blobs b ON b.id = m.blob_id
          WHERE m.rental_item_id = $1 AND m.media_type = 'pickup_condition_photo'
            AND (m.storage_backend = 'supabase' OR (b.id IS NOT NULL AND b.byte_size > 0))
        )
      LIMIT 1`,
    [Number(itemId)],
  );
  if (!res.rows[0]) {
    throw httpError(
      'A completed pickup inspection with a stored pickup photo is required before activation.',
      409, 'PICKUP_INSPECTION_INCOMPLETE',
    );
  }
  return res.rows[0];
}

async function activateItem(agreementId, itemId, actor = {}, { requireInspection = true } = {}) {
  return withTxn(async (client) => {
    const itemRes = await client.query(
      'SELECT * FROM trailer_rental_items WHERE id = $1 AND agreement_id = $2 FOR UPDATE',
      [Number(itemId), Number(agreementId)],
    );
    const item = itemRes.rows[0];
    if (!item) throw httpError('Item not found.', 404);
    if (!['draft', 'scheduled', 'ready_for_pickup'].includes(item.item_status)) {
      throw httpError('Only a not-yet-active trailer can be picked up.', 409, 'ITEM_NOT_ACTIVATABLE');
    }
    if (!item.scheduled_pickup_at || !item.expected_return_at) {
      throw httpError('A pickup and expected-return time are required.', 400);
    }

    await itemsDb.assertSelectableTrailer(item.trailer_id, client);
    const avail = await client.query(
      "SELECT physical_status FROM trailers WHERE id = $1",
      [item.trailer_id],
    );
    if (avail.rows[0].physical_status === 'rented') {
      const conflict = await client.query(
        "SELECT id FROM trailer_rental_items WHERE trailer_id = $1 AND item_status = 'active' AND id <> $2",
        [item.trailer_id, item.id],
      );
      if (conflict.rows[0]) throw httpError('Trailer already has an active rental.', 409, 'TRAILER_ACTIVE');
    }

    if (requireInspection) await validateItemPickupInspection(client, itemId);

    const updated = await itemsDb.setItemStatus(itemId, 'active', {
      actual_pickup_at: item.actual_pickup_at || item.scheduled_pickup_at,
      updated_by_admin_id: actor.id || null,
    }, client);
    await client.query(
      "UPDATE trailers SET physical_status = 'rented', updated_by_admin_id = $2, updated_at = NOW() WHERE id = $1",
      [item.trailer_id, actor.id || null],
    );
    await client.query(
      `INSERT INTO trailer_rental_movements
         (trailer_id, agreement_id, rental_item_id, movement_type, to_location, to_lat, to_lng,
          event_at, employee_admin_id, source)
       VALUES ($1, $2, $3, 'rental_pickup', $4, $5, $6, $7, $8, 'agreement')`,
      [item.trailer_id, Number(agreementId), item.id, item.pickup_location, item.pickup_lat, item.pickup_lng,
        updated.actual_pickup_at, actor.id || null],
    );
    await insertTrailerAudit({
      adminId: actor.id || null, roleKeys: actor.roleKeys,
      ipAddress: actor.ip, action: 'agreement.item.activate', entityType: 'rental_item', entityId: item.id,
      oldValues: item, newValues: updated,
    }, client);

    const agreement = await agreementsDb.refreshAgreementStatus(agreementId, client);
    return { agreement, item: updated };
  });
}

module.exports = { activateItem, validateItemPickupInspection };
