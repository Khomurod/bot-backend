'use strict';

/**
 * Next-action engine for the unified rental view (PURE — no I/O).
 *
 * Given an agreement, its items and lightweight evidence context, decides the
 * single most useful thing to do next, as {type, label, item_id?, urgent?}.
 * The Home page, the rentals list and the rental detail header all read this,
 * so the "what do I do now" answer is computed exactly once.
 */

const ACTION_LABELS = {
  complete_rental_details: 'Complete rental details',
  schedule_pickup: 'Schedule pickup',
  complete_pickup_inspection: 'Complete pickup inspection',
  add_pickup_photos: 'Add pickup photos',
  confirm_pickup: 'Confirm pickup',
  return_trailer: 'Return trailer',
  complete_return_inspection: 'Complete return inspection',
  generate_invoice: 'Create invoice',
  record_payment: 'Record payment',
  close_rental: 'Complete rental',
  none: null,
};

function action(type, extra = {}) {
  return { type, label: ACTION_LABELS[type], ...extra };
}

function hasPricing(item) {
  return Number(item.daily_rate) > 0 || Number(item.weekly_rate) > 0
    || Number(item.monthly_rate) > 0 || Number(item.flat_amount) > 0
    || item.included_in_bundle === true;
}

/**
 * Next action for one trailer on a rental.
 * @param {object} item     trailer_rental_items row (or normalized equivalent)
 * @param {object} evidence { pickupInspectionComplete, pickupPhotoCount,
 *                            returnInspectionComplete, returnPhotoCount }
 * @param {Date}   now
 */
function itemNextAction(item, evidence = {}, now = new Date()) {
  const withItem = (type, extra = {}) => action(type, { item_id: item.id, ...extra });
  switch (item.item_status) {
    case 'draft': {
      if (!item.scheduled_pickup_at || !item.expected_return_at || !hasPricing(item)) {
        return withItem('complete_rental_details');
      }
      return withItem('schedule_pickup');
    }
    case 'scheduled':
    case 'ready_for_pickup': {
      if (!evidence.pickupInspectionComplete) return withItem('complete_pickup_inspection');
      if (!Number(evidence.pickupPhotoCount)) return withItem('add_pickup_photos');
      return withItem('confirm_pickup');
    }
    case 'active': {
      const overdue = item.expected_return_at && new Date(item.expected_return_at) < now;
      if (evidence.returnInspectionStarted && !evidence.returnInspectionComplete) {
        return withItem('complete_return_inspection', overdue ? { urgent: true } : {});
      }
      return withItem('return_trailer', overdue ? { urgent: true } : {});
    }
    default:
      return action('none');
  }
}

const OPEN_ITEM_STATUSES = new Set(['draft', 'scheduled', 'ready_for_pickup', 'active']);

/**
 * Next action for a whole rental (agreement): the first open item's action, or
 * the money step once every trailer is back.
 * @param {object} agreement           header row (status)
 * @param {Array}  items               [{ item, evidence }]
 * @param {object} money               { hasUninvoicedReturns, outstanding }
 * @param {Date}   now
 */
function agreementNextAction(agreement, items = [], money = {}, now = new Date()) {
  if (['closed', 'cancelled'].includes(agreement.status)) return action('none');

  // The most urgent open item wins; otherwise the first open item.
  let first = null;
  for (const entry of items) {
    if (!OPEN_ITEM_STATUSES.has(entry.item.item_status)) continue;
    const candidate = itemNextAction(entry.item, entry.evidence, now);
    if (candidate.urgent) return candidate;
    if (!first) first = candidate;
  }
  if (first) return first;

  if (money.hasUninvoicedReturns) return action('generate_invoice');
  if (Number(money.outstanding) > 0) return action('record_payment');
  const anyReturned = items.some((e) => e.item.item_status === 'returned');
  if (anyReturned || items.length) return action('close_rental');
  return action('none');
}

module.exports = { ACTION_LABELS, itemNextAction, agreementNextAction };
