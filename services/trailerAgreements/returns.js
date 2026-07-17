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

async function returnItem(agreementId, itemId, input = {}, actor = {}) {
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

    const agreement = await agreementsDb.getAgreementById(agreementId, client);
    const timezone = item.billing_timezone_override || agreement.billing_timezone || 'America/Chicago';
    const window = { startAt: item.actual_pickup_at || item.scheduled_pickup_at, endAt: actualReturn, timezone };
    const line = buildItemLine(item, window, {
      damage_charge: input.damage_charge, cleaning_charge: input.cleaning_charge,
      late_fee: input.late_fee, other_charge: input.other_charge,
      description: input.description,
    });

    const updated = await itemsDb.setItemStatus(itemId, 'returned', {
      actual_return_at: actualReturn,
      return_location: input.return_location || null,
      return_lat: input.return_lat ?? null,
      return_lng: input.return_lng ?? null,
      updated_by_admin_id: actor.id || null,
    }, client);
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

module.exports = { returnItem };
