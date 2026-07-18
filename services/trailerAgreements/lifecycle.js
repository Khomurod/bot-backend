/**
 * Agreement lifecycle orchestration (transactional).
 *
 * Coordinates the data-access modules for the operations that must be atomic and
 * that must re-derive the agreement's status from its items in the SAME
 * transaction as the item change: add/remove/replace items, schedule, activate,
 * return, extend, change amount/rate. Availability and official-trailer checks
 * live in the data layer (database/trailerAgreements/items.js) and the DB
 * overlap constraint; this layer sequences them and writes amendments.
 *
 * Dependency direction: routes → this service → database/trailerAgreements +
 * database/trailerAudit → pool. No business logic in routes.
 */
'use strict';

const { pool } = require('../../database/pool');
const agreementsDb = require('../../database/trailerAgreements/agreements');
const itemsDb = require('../../database/trailerAgreements/items');
const amendmentsDb = require('../../database/trailerAgreements/amendments');
const { assertTrailerAvailable } = require('../../database/trailerAvailability');
const { insertTrailerAudit } = require('../../database/trailerAudit');

function httpError(message, status = 400, code) {
  return Object.assign(new Error(message), { status, code });
}

async function withTxn(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Create an agreement with an initial set of items, all in one transaction. */
async function createAgreementWithItems(input = {}, actor = {}) {
  return withTxn(async (client) => {
    const agreement = await agreementsDb.createAgreement(
      { ...input, created_by_admin_id: actor.id || null }, client,
    );
    const items = [];
    for (const it of input.items || []) {
      items.push(await itemsDb.addItem(agreement.id, { ...it, created_by_admin_id: actor.id || null }, client));
    }
    const refreshed = await agreementsDb.refreshAgreementStatus(agreement.id, client);
    return { agreement: refreshed || agreement, items };
  });
}

/** Add a trailer to an existing agreement via an amendment. */
async function addItemViaAmendment(agreementId, itemInput = {}, actor = {}, reason = null) {
  return withTxn(async (client) => {
    const agreement = await agreementsDb.getAgreementById(agreementId, client);
    if (!agreement) throw httpError('Agreement not found.', 404);
    if (['closed', 'cancelled'].includes(agreement.status)) {
      throw httpError('Cannot amend a closed or cancelled agreement.', 409, 'AGREEMENT_TERMINAL');
    }
    const amendment = await amendmentsDb.createAmendment(agreementId, {
      amendment_type: 'add_trailer', reason, created_by_admin_id: actor.id || null,
    }, client);
    const item = await itemsDb.addItem(agreementId, {
      ...itemInput, added_amendment_id: amendment.id, created_by_admin_id: actor.id || null,
    }, client);
    const refreshed = await agreementsDb.refreshAgreementStatus(agreementId, client);
    return { agreement: refreshed, amendment, item };
  });
}

/** Remove a trailer before pickup via an amendment. Only draft/scheduled items. */
async function removeItemViaAmendment(agreementId, itemId, actor = {}, reason = null) {
  return withTxn(async (client) => {
    const item = await itemsDb.getItemById(itemId, client);
    if (!item || Number(item.agreement_id) !== Number(agreementId)) throw httpError('Item not found.', 404);
    if (!['draft', 'scheduled', 'ready_for_pickup'].includes(item.item_status)) {
      throw httpError('Only a trailer that has not been picked up can be removed.', 409, 'ITEM_NOT_REMOVABLE');
    }
    const amendment = await amendmentsDb.createAmendment(agreementId, {
      amendment_type: 'remove_trailer', reason, rental_item_id: itemId, created_by_admin_id: actor.id || null,
    }, client);
    const updated = await itemsDb.setItemStatus(itemId, 'removed_before_pickup',
      { removed_amendment_id: amendment.id }, client);
    const refreshed = await agreementsDb.refreshAgreementStatus(agreementId, client);
    return { agreement: refreshed, amendment, item: updated };
  });
}

/** Replace a not-yet-picked-up trailer with another via an amendment. */
async function replaceItemViaAmendment(agreementId, itemId, newItemInput = {}, actor = {}, reason = null) {
  return withTxn(async (client) => {
    const item = await itemsDb.getItemById(itemId, client);
    if (!item || Number(item.agreement_id) !== Number(agreementId)) throw httpError('Item not found.', 404);
    if (!['draft', 'scheduled', 'ready_for_pickup'].includes(item.item_status)) {
      throw httpError('Only a trailer that has not been picked up can be replaced.', 409, 'ITEM_NOT_REPLACEABLE');
    }
    const amendment = await amendmentsDb.createAmendment(agreementId, {
      amendment_type: 'replace_trailer', reason, rental_item_id: itemId, created_by_admin_id: actor.id || null,
    }, client);
    const replacement = await itemsDb.addItem(agreementId, {
      scheduled_pickup_at: item.scheduled_pickup_at,
      expected_return_at: item.expected_return_at,
      pickup_location: item.pickup_location,
      pricing_mode: item.pricing_mode,
      daily_rate: item.daily_rate, weekly_rate: item.weekly_rate,
      monthly_rate: item.monthly_rate, flat_amount: item.flat_amount,
      ...newItemInput,
      item_status: item.item_status,
      added_amendment_id: amendment.id,
      created_by_admin_id: actor.id || null,
      // The replacement legitimately inherits the outgoing item's pre-pickup
      // status; anything active-or-beyond is still refused.
    }, client, { allowStatuses: ['draft', 'scheduled', 'ready_for_pickup'] });
    const replaced = await itemsDb.setItemStatus(itemId, 'replaced',
      { removed_amendment_id: amendment.id, replacement_item_id: replacement.id }, client);
    const refreshed = await agreementsDb.refreshAgreementStatus(agreementId, client);
    return { agreement: refreshed, amendment, replacedItem: replaced, replacementItem: replacement };
  });
}

/** Schedule a draft item (set its window and mark scheduled). */
async function scheduleItem(agreementId, itemId, { scheduled_pickup_at, expected_return_at, pickup_location, version }, actor = {}) {
  return withTxn(async (client) => {
    const item = await itemsDb.getItemById(itemId, client);
    if (!item || Number(item.agreement_id) !== Number(agreementId)) throw httpError('Item not found.', 404);
    if (!scheduled_pickup_at || !expected_return_at) throw httpError('Pickup and return times are required.', 400);
    await assertTrailerAvailable(client, {
      trailerId: item.trailer_id, startAt: scheduled_pickup_at, endAt: expected_return_at,
      excludeItemId: item.id,
    });
    const updated = await itemsDb.setItemStatus(itemId, 'scheduled', {
      scheduled_pickup_at, expected_return_at,
      pickup_location: pickup_location ?? item.pickup_location,
    }, client, version);
    const refreshed = await agreementsDb.refreshAgreementStatus(agreementId, client);
    return { agreement: refreshed, item: updated };
  });
}

const CLOSE_BLOCKING = new Set(['draft', 'scheduled', 'ready_for_pickup', 'active', 'disputed']);

/**
 * Close an agreement only when every item is terminal. Any item still in
 * draft/scheduled/ready_for_pickup/active — or disputed — blocks the close,
 * naming the offending unit numbers.
 */
async function closeAgreementValidated(agreementId, actor = {}, { version } = {}) {
  return withTxn(async (client) => {
    const agreement = await agreementsDb.getAgreementById(agreementId, client);
    if (!agreement) throw httpError('Agreement not found.', 404);
    if (agreement.status === 'closed') return { agreement };
    if (version !== undefined && version !== null && Number(agreement.version) !== Number(version)) {
      throw Object.assign(
        new Error('This record changed while you were editing. Reload and try again.'),
        { status: 409, code: 'VERSION_CONFLICT', currentVersion: agreement.version },
      );
    }
    const open = await client.query(
      `SELECT t.unit_number FROM trailer_rental_items it
         JOIN trailers t ON t.id = it.trailer_id
        WHERE it.agreement_id = $1 AND it.item_status = ANY($2)
        ORDER BY t.unit_number`,
      [Number(agreementId), [...CLOSE_BLOCKING]],
    );
    if (open.rows.length) {
      const units = open.rows.map((r) => r.unit_number).join(', ');
      throw httpError(
        `This rental cannot be completed yet: trailer${open.rows.length > 1 ? 's' : ''} ${units} `
        + 'still need to be returned or resolved first.',
        409, 'AGREEMENT_NOT_CLOSABLE',
      );
    }
    const closed = await agreementsDb.closeAgreement(agreementId, actor.id || null, client);
    await insertTrailerAudit({
      adminId: actor.id || null, roleKeys: actor.roleKeys, ipAddress: actor.ip,
      action: 'agreement.close', entityType: 'agreement', entityId: Number(agreementId),
      oldValues: agreement, newValues: closed,
    }, client);
    return { agreement: closed };
  });
}

module.exports = {
  withTxn,
  httpError,
  createAgreementWithItems,
  addItemViaAmendment,
  removeItemViaAmendment,
  replaceItemViaAmendment,
  scheduleItem,
  closeAgreementValidated,
};
