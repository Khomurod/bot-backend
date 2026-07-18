/**
 * Wizard Price step model (§1): the three plain-language charging choices,
 * their validation, "Use the same rate for all trailers", and the mapping onto
 * the agreement/item payload.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = path.resolve(__dirname, '../admin/src/pages/trailer/rentals/priceStepModel.js');
let m;
test.before(async () => { m = await import(pathToFileURL(MODULE).href); });

test('exactly the three required user-facing options exist', () => {
  assert.deepEqual(m.PRICING_CHOICES.map((c) => c.label), [
    'One total price for all trailers',
    'Each trailer has its own rate',
    'Enter a final amount manually',
  ]);
});

test('total pricing requires the total amount', () => {
  assert.ok(m.priceBlockers('total', { totalAmount: '' }).length > 0);
  assert.deepEqual(m.priceBlockers('total', { totalAmount: '9000' }), []);
});

test('manual pricing requires amount AND reason', () => {
  const missing = m.priceBlockers('manual', { manualAmount: '5000', manualReason: '' });
  assert.ok(missing.some((s) => /why|explain/i.test(s)));
  assert.deepEqual(m.priceBlockers('manual', { manualAmount: '5000', manualReason: 'package deal' }), []);
});

test('per-trailer pricing requires a positive rate for every trailer', () => {
  const items = [
    { pricing_mode: 'daily', daily_rate: '100' },
    { pricing_mode: 'weekly', weekly_rate: '' },
  ];
  const missing = m.priceBlockers('per_trailer', { items });
  assert.deepEqual(missing, ['Enter a rate for trailer 2']);
});

test('applySameRate copies the first trailer\'s mode and rate to all', () => {
  const items = [
    { pricing_mode: 'weekly', weekly_rate: '500', daily_rate: '' },
    { pricing_mode: 'daily', daily_rate: '120', weekly_rate: '' },
  ];
  const out = m.applySameRate(items);
  assert.equal(out[1].pricing_mode, 'weekly');
  assert.equal(out[1].weekly_rate, '500');
  assert.equal(out[1].daily_rate, '');
});

test('total choice maps to a bundle_flat agreement with bundle items', () => {
  const { agreement, itemPatch } = m.buildPricingPayload('total', { totalAmount: '9000', deposit: '1500', discount: '0' });
  assert.equal(agreement.pricing_mode, 'bundle_flat');
  assert.equal(agreement.current_agreed_amount, 9000);
  assert.equal(agreement.deposit_amount, 1500);
  assert.deepEqual(itemPatch({}), { pricing_mode: 'included_in_bundle', included_in_bundle: true });
});

test('manual choice records the reason in the agreement notes', () => {
  const { agreement } = m.buildPricingPayload('manual', { manualAmount: '5000', manualReason: 'negotiated', notes: 'base note' });
  assert.equal(agreement.current_agreed_amount, 5000);
  assert.match(agreement.notes, /base note/);
  assert.match(agreement.notes, /Manual amount: negotiated/);
});

test('per-trailer choice keeps per_item pricing and each item\'s own mode', () => {
  const { agreement, itemPatch } = m.buildPricingPayload('per_trailer', { deposit: '0', discount: '50' });
  assert.equal(agreement.pricing_mode, 'per_item');
  assert.equal(agreement.agreement_discount, 50);
  assert.deepEqual(itemPatch({ pricing_mode: 'monthly' }), { pricing_mode: 'monthly' });
});
