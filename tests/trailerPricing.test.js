'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { priceItem } = require('../services/trailerPricing/itemPricing');
const { buildInvoiceLines } = require('../services/trailerPricing/invoiceBuilder');

const DAY = 24 * 60 * 60 * 1000;
const start = new Date('2026-01-01T12:00:00Z');
const fiveDays = new Date(start.getTime() + 5 * DAY);

test('daily pricing multiplies billable days by the daily rate', () => {
  const p = priceItem({ pricing_mode: 'daily', daily_rate: 100 }, { startAt: start, endAt: fiveDays });
  assert.equal(p.unit, 'day');
  assert.ok(p.billableDays >= 5, 'at least five billable days');
  assert.equal(p.baseAmount, p.unitPrice * p.quantity);
  assert.equal(p.lineTotal, p.baseAmount);
});

test('weekly pricing rounds up to whole weeks', () => {
  const p = priceItem({ pricing_mode: 'weekly', weekly_rate: 300 }, { startAt: start, endAt: fiveDays });
  assert.equal(p.unit, 'week');
  assert.equal(p.quantity, 1);
  assert.equal(p.baseAmount, 300);
});

test('monthly pricing rounds up to whole months', () => {
  const p = priceItem({ pricing_mode: 'monthly', monthly_rate: 1000 }, { startAt: start, endAt: fiveDays });
  assert.equal(p.unit, 'month');
  assert.equal(p.quantity, 1);
  assert.equal(p.baseAmount, 1000);
});

test('flat pricing ignores days', () => {
  const p = priceItem({ pricing_mode: 'flat', flat_amount: 750 }, { startAt: start, endAt: fiveDays });
  assert.equal(p.baseAmount, 750);
  assert.equal(p.billableDays, 0);
});

test('included_in_bundle contributes no base amount', () => {
  const p = priceItem({ pricing_mode: 'included_in_bundle', daily_rate: 100 }, { startAt: start, endAt: fiveDays });
  assert.equal(p.baseAmount, 0);
  assert.equal(p.lineTotal, 0);
});

test('additional and discount adjust the line total', () => {
  const p = priceItem(
    { pricing_mode: 'flat', flat_amount: 500, additional_amount: 50, discount_amount: 100 },
    { startAt: start, endAt: fiveDays },
  );
  assert.equal(p.lineTotal, 450);
});

test('combined per-item invoice sums each trailer line', () => {
  const agreement = { pricing_mode: 'per_item' };
  const entries = [
    { item: { id: 1, trailer_id: 11, pricing_mode: 'flat', flat_amount: 300 }, window: {} },
    { item: { id: 2, trailer_id: 12, pricing_mode: 'flat', flat_amount: 200 }, window: {} },
  ];
  const { lines, total } = buildInvoiceLines(agreement, entries);
  assert.equal(lines.length, 2);
  assert.equal(total, 500);
});

test('bundle invoice bills one header line and zeroes per-item rental', () => {
  const agreement = { pricing_mode: 'bundle_flat', current_agreed_amount: 1200, agreement_discount: 0 };
  const entries = [
    { item: { id: 1, trailer_id: 11, pricing_mode: 'daily', daily_rate: 100 }, window: { startAt: start, endAt: fiveDays } },
    { item: { id: 2, trailer_id: 12, pricing_mode: 'daily', daily_rate: 100 }, window: { startAt: start, endAt: fiveDays } },
  ];
  const { lines, total } = buildInvoiceLines(agreement, entries);
  const bundle = lines.find((l) => l.line_type === 'bundle' && l.unit === 'bundle');
  assert.ok(bundle, 'a bundle header line exists');
  assert.equal(bundle.line_total, 1200);
  assert.equal(total, 1200, 'per-item rental lines are zeroed under a bundle');
});

test('mixed: bundle header plus an out-of-bundle item still totals correctly', () => {
  const agreement = { pricing_mode: 'per_item' };
  const entries = [
    { item: { id: 1, trailer_id: 11, pricing_mode: 'included_in_bundle' }, window: {} },
    { item: { id: 2, trailer_id: 12, pricing_mode: 'flat', flat_amount: 400 }, window: {} },
  ];
  const { total } = buildInvoiceLines(agreement, entries);
  assert.equal(total, 400);
});
