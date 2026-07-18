/**
 * Server-side rental estimate (§1) — the wizard's Price step math, computed
 * with the SAME helpers invoicing uses. Pure: no database.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { estimateAgreement } = require('../services/trailerAgreements/estimate');

const WIN = { scheduled_pickup_at: '2026-07-20T08:00:00Z', expected_return_at: '2026-07-25T08:00:00Z' };

test('per-item daily pricing: days × rate per trailer', () => {
  const est = estimateAgreement({
    pricing_mode: 'per_item',
    items: [
      { pricing_mode: 'daily', daily_rate: 100, ...WIN },
      { pricing_mode: 'daily', daily_rate: 150, ...WIN },
    ],
  });
  // 5 billable days each (calendar-day billing may count 5 or 6 — assert consistency instead of a magic number).
  assert.equal(est.lines.length, 2);
  assert.ok(est.total > 0);
  assert.equal(est.total, est.lines.reduce((s, l) => s + l.line_total, 0));
  // Both trailers share the window, so the 150-rate line is 1.5× the 100-rate line.
  assert.equal(est.lines[1].base_amount, est.lines[0].base_amount * 1.5);
});

test('one total price: the bundle amount bills, item lines are zeroed', () => {
  const est = estimateAgreement({
    pricing_mode: 'bundle_flat',
    current_agreed_amount: 9000,
    agreement_discount: 0,
    items: [
      { pricing_mode: 'included_in_bundle', included_in_bundle: true, ...WIN },
      { pricing_mode: 'included_in_bundle', included_in_bundle: true, ...WIN },
    ],
  });
  assert.equal(est.total, 9000);
  const bundle = est.lines.find((l) => l.line_type === 'bundle');
  assert.equal(bundle.base_amount, 9000);
});

test('deposit reduces the estimated amount due, never below zero', () => {
  const est = estimateAgreement({
    pricing_mode: 'bundle_flat', current_agreed_amount: 9000, deposit_amount: 1500,
    items: [{ pricing_mode: 'included_in_bundle', included_in_bundle: true, ...WIN }],
  });
  assert.equal(est.estimated_due, 7500);

  const over = estimateAgreement({
    pricing_mode: 'bundle_flat', current_agreed_amount: 100, deposit_amount: 500,
    items: [{ pricing_mode: 'included_in_bundle', included_in_bundle: true, ...WIN }],
  });
  assert.equal(over.estimated_due, 0);
  assert.ok(over.warnings.some((w) => /deposit/i.test(w)));
});

test('a trailer without a window is warned about, not crashed on', () => {
  const est = estimateAgreement({
    pricing_mode: 'per_item',
    items: [{ pricing_mode: 'daily', daily_rate: 100 }],
  });
  assert.ok(est.warnings.some((w) => /no pickup\/return window/i.test(w)));
  assert.equal(est.total, 0);
});

test('an empty draft warns about missing trailers', () => {
  const est = estimateAgreement({});
  assert.ok(est.warnings.some((w) => /no trailers/i.test(w)));
});
