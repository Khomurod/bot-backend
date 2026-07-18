/**
 * Status vocabulary contract: one shared map from technical statuses to
 * user-facing labels + tones, consumed by every trailer page.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const vocab = () => import(pathToFileURL(
  path.resolve(__dirname, '../admin/src/pages/trailer/trailerStatusVocabulary.js'),
).href);

test('every rental/item status has a label and tone', async () => {
  const { RENTAL_STATUS_LABELS, rentalStatus } = await vocab();
  const statuses = ['draft', 'scheduled', 'ready_for_pickup', 'active', 'partially_active',
    'returned', 'partially_returned', 'closed', 'cancelled', 'disputed'];
  for (const s of statuses) {
    assert.ok(RENTAL_STATUS_LABELS[s]?.label, `${s} needs a label`);
    assert.ok(['neutral', 'attention', 'success'].includes(RENTAL_STATUS_LABELS[s].tone), `${s} tone`);
  }
  assert.equal(rentalStatus('draft').label, 'Being set up');
  assert.equal(rentalStatus('disputed').tone, 'attention');
  // Unknown statuses degrade to their raw value, never crash.
  assert.equal(rentalStatus('weird').label, 'weird');
});

test('every invoice status has a label; overdue is attention-toned', async () => {
  const { INVOICE_STATUS_LABELS, invoiceStatus } = await vocab();
  for (const s of ['draft', 'issued', 'partially_paid', 'paid', 'overdue', 'voided', 'disputed']) {
    assert.ok(INVOICE_STATUS_LABELS[s]?.label, `${s} needs a label`);
  }
  assert.equal(invoiceStatus('issued').label, 'Waiting for payment');
  assert.equal(invoiceStatus('overdue').tone, 'attention');
});

test('no technical jargon leaks into labels', async () => {
  const { RENTAL_STATUS_LABELS, INVOICE_STATUS_LABELS, TRAILER_CONDITION_LABELS } = await vocab();
  const all = [...Object.values(RENTAL_STATUS_LABELS), ...Object.values(INVOICE_STATUS_LABELS),
    ...Object.values(TRAILER_CONDITION_LABELS)].map((v) => v.label.toLowerCase());
  for (const label of all) {
    assert.ok(!/legacy|blob|backend|reconcil|amendment|_/.test(label), `"${label}" reads technical`);
  }
});
