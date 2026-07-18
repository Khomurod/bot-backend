/**
 * Truthful payment confirmation message (§8). The message must reflect the REAL
 * Telegram delivery state and never claim a confirmation is on its way when the
 * notification already failed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = path.resolve(__dirname, '../admin/src/pages/trailer/money/paymentConfirmation.js');
let m;
test.before(async () => { m = await import(pathToFileURL(MODULE).href); });

test('a failed notification never says the confirmation is on its way', () => {
  const msg = m.paymentConfirmationMessage({
    payment: { amount: 500 }, invoice: { invoice_number: 'INV-1', outstanding_balance: 0 },
    notification: { status: 'failed' },
  });
  assert.ok(!/on its way/i.test(msg));
  assert.match(msg, /could not be sent/i);
  assert.match(msg, /retry it from the invoice/i);
});

test('a pending notification promises delivery, a sent one confirms it', () => {
  assert.match(m.deliveryStateLine({ status: 'pending' }), /will be sent/i);
  assert.match(m.deliveryStateLine({ status: 'processing' }), /will be sent/i);
  assert.match(m.deliveryStateLine({ status: 'sent' }), /was sent/i);
  assert.equal(m.deliveryStateLine(null), null);
  assert.equal(m.deliveryStateLine({ status: 'weird' }), null);
});

test('the message states amount, invoice and remaining balance', () => {
  const msg = m.paymentConfirmationMessage({
    payment: { amount: 300 }, invoice: { invoice_number: 'INV-9', outstanding_balance: 200 },
    notification: { status: 'pending' },
  });
  assert.match(msg, /\$300\.00/);
  assert.match(msg, /INV-9/);
  assert.match(msg, /Remaining balance: \$200\.00/);
});

test('paid-in-full is stated instead of a remaining balance', () => {
  const msg = m.paymentConfirmationMessage({
    payment: { amount: 300 }, invoice: { invoice_number: 'INV-9', outstanding_balance: 0 },
    notification: { status: 'sent' },
  });
  assert.match(msg, /paid in full/i);
  assert.ok(!/Remaining balance/i.test(msg));
});

test('a banked overpayment credit is reported', () => {
  const msg = m.paymentConfirmationMessage({
    payment: { amount: 600 }, invoice: { invoice_number: 'INV-2', outstanding_balance: 0 },
    credit: { original_amount: 100 }, notification: { status: 'pending' },
  });
  assert.match(msg, /\$100\.00 extra was saved as company credit/i);
});
