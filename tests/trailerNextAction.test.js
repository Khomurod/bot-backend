/**
 * Next-action engine (pure) — the single "what do I do now" decision used by
 * Home, the rentals list and the rental detail header.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { itemNextAction, agreementNextAction } = require('../services/trailerNextAction');

const NOW = new Date('2026-07-17T12:00:00Z');
const future = '2026-08-01T12:00:00Z';
const past = '2026-07-01T12:00:00Z';

const item = (over = {}) => ({
  id: 1, item_status: 'draft', scheduled_pickup_at: null, expected_return_at: null,
  daily_rate: null, weekly_rate: null, monthly_rate: null, flat_amount: null,
  included_in_bundle: false, ...over,
});

test('draft without dates or pricing asks for rental details', () => {
  assert.equal(itemNextAction(item(), {}, NOW).type, 'complete_rental_details');
  assert.equal(itemNextAction(item({ scheduled_pickup_at: past, expected_return_at: future }), {}, NOW).type,
    'complete_rental_details');
});

test('a complete draft asks to schedule the pickup', () => {
  const a = itemNextAction(item({ scheduled_pickup_at: past, expected_return_at: future, daily_rate: 100 }), {}, NOW);
  assert.equal(a.type, 'schedule_pickup');
  assert.equal(a.item_id, 1);
  assert.ok(a.label);
});

test('scheduled walks inspection → photos → confirm', () => {
  const scheduled = item({ item_status: 'scheduled', scheduled_pickup_at: past, expected_return_at: future, daily_rate: 100 });
  assert.equal(itemNextAction(scheduled, {}, NOW).type, 'complete_pickup_inspection');
  assert.equal(itemNextAction(scheduled, { pickupInspectionComplete: true }, NOW).type, 'add_pickup_photos');
  assert.equal(itemNextAction(scheduled, { pickupInspectionComplete: true, pickupPhotoCount: 2 }, NOW).type, 'confirm_pickup');
});

test('an active trailer past its expected return is an urgent return', () => {
  const active = item({ item_status: 'active', expected_return_at: past });
  const a = itemNextAction(active, {}, NOW);
  assert.equal(a.type, 'return_trailer');
  assert.equal(a.urgent, true);
  assert.equal(itemNextAction(item({ item_status: 'active', expected_return_at: future }), {}, NOW).urgent, undefined);
});

test('agreement bubbles the urgent item first, then money steps, then close', () => {
  const agreement = { status: 'partially_returned' };
  const entries = [
    { item: item({ id: 1, item_status: 'returned' }), evidence: {} },
    { item: item({ id: 2, item_status: 'active', expected_return_at: past }), evidence: {} },
  ];
  const urgent = agreementNextAction(agreement, entries, {}, NOW);
  assert.equal(urgent.type, 'return_trailer');
  assert.equal(urgent.item_id, 2);

  const allBack = [{ item: item({ id: 1, item_status: 'returned' }), evidence: {} }];
  assert.equal(agreementNextAction({ status: 'returned' }, allBack, { hasUninvoicedReturns: true }, NOW).type, 'generate_invoice');
  assert.equal(agreementNextAction({ status: 'returned' }, allBack, { outstanding: 250 }, NOW).type, 'record_payment');
  assert.equal(agreementNextAction({ status: 'returned' }, allBack, {}, NOW).type, 'close_rental');
  assert.equal(agreementNextAction({ status: 'closed' }, allBack, {}, NOW).type, 'none');
});
