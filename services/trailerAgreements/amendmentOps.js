/**
 * Amount / rate / term amendment operations (transactional).
 *
 * These change agreement or item pricing and MUST leave an immutable amendment
 * record. Extracted from the lifecycle module to keep each file focused.
 */
'use strict';

const { withTxn, httpError } = require('./lifecycle');
const agreementsDb = require('../../database/trailerAgreements/agreements');
const itemsDb = require('../../database/trailerAgreements/items');
const amendmentsDb = require('../../database/trailerAgreements/amendments');

const PRICING_FIELDS = ['pricing_mode', 'daily_rate', 'weekly_rate', 'monthly_rate', 'flat_amount',
  'included_in_bundle', 'additional_amount', 'discount_amount', 'deposit_allocation'];

/** Change the agreement's current agreed amount, recording the delta. */
async function changeAmount(agreementId, newAmount, actor = {}, reason = null, version) {
  return withTxn(async (client) => {
    const agreement = await agreementsDb.getAgreementById(agreementId, client);
    if (!agreement) throw httpError('Agreement not found.', 404);
    if (['closed', 'cancelled'].includes(agreement.status)) {
      throw httpError('Cannot amend a closed or cancelled agreement.', 409);
    }
    const prev = Number(agreement.current_agreed_amount);
    const next = Number(newAmount);
    const amendment = await amendmentsDb.createAmendment(agreementId, {
      amendment_type: next >= prev ? 'increase_amount' : 'decrease_amount',
      previous_amount: prev, new_amount: next, change_amount: next - prev,
      reason, created_by_admin_id: actor.id || null,
    }, client);
    const updated = await agreementsDb.updateAgreement(agreementId,
      { current_agreed_amount: next, updated_by_admin_id: actor.id || null }, version, client);
    return { agreement: updated, amendment };
  });
}

/** Change an item's rate, recording an amendment with prior/next terms. */
async function changeItemRate(agreementId, itemId, patch = {}, actor = {}, reason = null, version) {
  return withTxn(async (client) => {
    const item = await itemsDb.getItemById(itemId, client);
    if (!item || Number(item.agreement_id) !== Number(agreementId)) throw httpError('Item not found.', 404);
    // Whitelist: only pricing fields may flow into the UPDATE.
    const ratePatch = {};
    for (const key of PRICING_FIELDS) {
      if (patch[key] !== undefined) ratePatch[key] = patch[key];
    }
    const prevTerms = {
      pricing_mode: item.pricing_mode, daily_rate: item.daily_rate,
      weekly_rate: item.weekly_rate, monthly_rate: item.monthly_rate, flat_amount: item.flat_amount,
    };
    const nextTerms = { ...prevTerms, ...ratePatch };
    const amendment = await amendmentsDb.createAmendment(agreementId, {
      amendment_type: 'change_rate', rental_item_id: itemId,
      previous_pricing_terms: prevTerms, new_pricing_terms: nextTerms,
      reason, created_by_admin_id: actor.id || null,
    }, client);
    const updated = await itemsDb.setItemStatus(itemId, item.item_status,
      { ...ratePatch, updated_by_admin_id: actor.id || null }, client, version ?? patch.version);
    return { item: updated, amendment };
  });
}

/** Extend an item's expected return date, recording an amendment. */
async function extendReturn(agreementId, itemId, newExpectedReturn, actor = {}, reason = null, version) {
  return withTxn(async (client) => {
    const item = await itemsDb.getItemById(itemId, client);
    if (!item || Number(item.agreement_id) !== Number(agreementId)) throw httpError('Item not found.', 404);
    const amendment = await amendmentsDb.createAmendment(agreementId, {
      amendment_type: 'extend_return', rental_item_id: itemId,
      previous_pricing_terms: { expected_return_at: item.expected_return_at },
      new_pricing_terms: { expected_return_at: newExpectedReturn },
      reason, created_by_admin_id: actor.id || null,
    }, client);
    const updated = await itemsDb.setItemStatus(itemId, item.item_status,
      { expected_return_at: newExpectedReturn, updated_by_admin_id: actor.id || null }, client, version);
    return { item: updated, amendment };
  });
}

module.exports = { changeAmount, changeItemRate, extendReturn };
