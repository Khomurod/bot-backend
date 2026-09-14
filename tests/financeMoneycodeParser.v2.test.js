'use strict';

/**
 * Reading the finance group's real messages.
 *
 * EVERY FIXTURE HERE IS THE SHAPE OF A MESSAGE PRODUCTION ACTUALLY SENT, with
 * the digits and names changed. The parser that shipped first had never seen
 * one, and it showed: the live EFS format came back `not_moneycode`, because
 * "Money Transfer code" was not in a keyword list.
 *
 * THAT WAS THREE FAULTS IN ONE MESSAGE, and the third is the one a keyword
 * patch would have left behind:
 *
 *   1. the phrase was unknown, so the message was not finance at all;
 *   2. `Report Reference` is a second long number, so with the phrase added it
 *      would have become "2 candidate codes" — ambiguous, and wrong;
 *   3. `Amount: 480.00` has no `$`, so the amount was invisible.
 *
 * So the tests below are about LABELS, and about the one property that makes
 * tolerant matching safe: the label may be misspelled, the number may not.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseMoneycodeMessage, STATUS, PARSER_VERSION } = require('../lib/finance/moneycode');
const { labelToField } = require('../lib/finance/moneycode/labels');

/** The live EFS format, anonymised. */
const EFS = [
  'Money Transfer code: 1491583146',
  'Report Reference: 165373918',
  'Amount: 480.00',
  'Issued to: WENZE INVESTMENTS LLC',
  'Notes: B-1 911 BRHANE GEBRU',
].join('\n');

test('the production EFS format is read, field by field', () => {
  const r = parseMoneycodeMessage(EFS);
  assert.equal(r.status, STATUS.PARSED, 'this is the message that read as not_moneycode');
  assert.equal(r.codeNormalized, '1491583146');
  assert.equal(r.reportReference, '165373918');
  assert.equal(r.amount, 480);
  assert.equal(r.issuedTo, 'WENZE INVESTMENTS LLC');
  assert.equal(r.notes, 'B-1 911 BRHANE GEBRU');
});

/** The fault a keyword patch would have left in place. */
test('a Report Reference is NEVER a second candidate code', () => {
  const r = parseMoneycodeMessage(EFS);
  assert.deepEqual(r.codes, ['1491583146'],
    'two long numbers in one message is not two codes when one of them is labelled a reference');
  assert.notEqual(r.status, STATUS.AMBIGUOUS);
});

test('Amount: 480.00 is read without a currency symbol', () => {
  assert.equal(parseMoneycodeMessage('Money code: 1491583146\nAmount: 480.00').amount, 480);
  assert.equal(parseMoneycodeMessage('Money code: 1491583146\nAmount: $480').amount, 480);
  assert.equal(parseMoneycodeMessage('Money code: 1491583146\nAmount: USD 1,234.56').amount, 1234.56);
});

// ── tolerant about the wording, exact about the number ─────────────────────

test('the label may be misspelled, spaced oddly or cased anyhow', () => {
  for (const label of [
    'Money Transfer code', 'Money Transfer cod', 'Money Trasfer Code',
    'money transfercode', 'MONEY TRANSFER CODE', 'moneycode', 'Money Code',
    'EFS code', 'EFS cod', 'efs', 'Comchek', 'Comcheck', 'Express code',
  ]) {
    const r = parseMoneycodeMessage(`${label}: 1491583146\nAmount: 480.00`);
    assert.equal(r.status, STATUS.PARSED, `"${label}" should still be a money code`);
    assert.equal(r.codeNormalized, '1491583146', `"${label}" must not change the digits`);
  }
});

test('a missing colon and extra whitespace are still the same field', () => {
  assert.equal(parseMoneycodeMessage('Money Transfer code 1491583146').codeNormalized, '1491583146');
  assert.equal(parseMoneycodeMessage('  Money  Transfer  code :   1491583146  ').codeNormalized, '1491583146');
});

/**
 * THE SAFETY PROPERTY. Tolerance is for the label and stops there — a number is
 * copied as written or not taken. A parser that could "correct" a digit could
 * invent money.
 */
test('a short label must be exactly right, so ordinary words are not labels', () => {
  assert.equal(labelToField('efs').field, 'money_code');
  assert.equal(labelToField('eft'), null, 'one edit from a three-letter label is not that label');
  assert.equal(labelToField('ref').field, 'reference');
  assert.equal(labelToField('red'), null);
});

test('grouping is removed from a code and nothing else is', () => {
  assert.equal(parseMoneycodeMessage('Money code: 1491-583-146').codeNormalized, '1491583146');
  assert.equal(parseMoneycodeMessage('Money code: 1491 583 146').codeNormalized, '1491583146');
});

test('ordinary conversation in the finance group is left alone', () => {
  for (const chat of ['morning all', 'is the truck loaded yet', 'call me when you can']) {
    assert.equal(parseMoneycodeMessage(chat).status, STATUS.NOT_MONEYCODE, chat);
  }
});

test('two DIFFERENT labelled codes stay ambiguous rather than being picked between', () => {
  const r = parseMoneycodeMessage('Money code: 1491583146\nMoney code: 9999999999');
  assert.equal(r.status, STATUS.AMBIGUOUS);
  assert.equal(r.codeNormalized, null, 'nothing is chosen when the message disagrees with itself');
});

test('a finance word with no readable code is unparsed, and keeps saying so', () => {
  const r = parseMoneycodeMessage('sent the comchek over, let me know');
  assert.equal(r.status, STATUS.UNPARSED);
  assert.match(r.reason, /no code/);
});

test('the version is stamped so a re-read can find what an older parser saw', () => {
  assert.equal(PARSER_VERSION, 2);
  assert.equal(parseMoneycodeMessage(EFS).parserVersion, 2);
});

// ── a void is not an issue ─────────────────────────────────────────────────

test('a void message never reads as issuing the code it names', () => {
  const r = parseMoneycodeMessage('voided 1491583146');
  assert.equal(r.status, STATUS.VOID_ACTION);
  assert.equal(r.codeNormalized, null, 'a void must not create a money code row');
  assert.deepEqual(r.void.codes, ['1491583146']);
});

test('asking to void is a request, and a question is not an action', () => {
  assert.equal(parseMoneycodeMessage('please void 1491583146').status, STATUS.VOID_REQUEST);
  assert.equal(parseMoneycodeMessage('need to void this one?').status, STATUS.VOID_REQUEST);
  assert.equal(parseMoneycodeMessage('should we void this?').status, STATUS.VOID_REQUEST);
  assert.equal(parseMoneycodeMessage('void this').status, STATUS.VOID_REQUEST);
});

test('"voided" on its own is a completed action', () => {
  assert.equal(parseMoneycodeMessage('voided').status, STATUS.VOID_ACTION);
  assert.equal(parseMoneycodeMessage('done, voided').status, STATUS.VOID_ACTION);
});

test('a refusal to void is not a void', () => {
  assert.equal(parseMoneycodeMessage('do not void that one').status, STATUS.NOT_MONEYCODE);
});

/**
 * ONE MESSAGE DOING TWO THINGS.
 *
 * "Voided — replacement below:" followed by a labelled code is a real shape,
 * and reading it as only a void threw the new code away in silence: the status
 * was settled, so nothing flagged it, and the money in it would never have
 * appeared on any screen or in any total. It goes to a person instead.
 */
test('a message that both voids and issues goes to a person, not to one reading', () => {
  const out = parseMoneycodeMessage(
    'Voided. Replacement below.\nMoney Transfer code: 2288341907\nAmount: 480.00',
  );
  assert.equal(out.status, STATUS.NEEDS_REVIEW);
  assert.match(out.reason, /both reports a void and issues a code/);
  assert.ok(out.codes.includes('2288341907'), 'the new code is not lost');
  assert.equal(out.void.kind, 'completed', 'and the void reading travels with it');
  assert.equal(out.code, null, 'nothing is recorded as issued from an unsettled message');
});

test('a code merely NAMED in a void is still just the void, not an issue', () => {
  // The distinction is the LABEL. Without one, "void 1491583146" is a void
  // whose subject happens to be written out — not a message issuing a code.
  const out = parseMoneycodeMessage('voided 1491583146');
  assert.equal(out.status, STATUS.VOID_ACTION);
  assert.deepEqual(out.codes, ['1491583146']);
});

test('a void beside an AMBIGUOUS labelled code is still a void', () => {
  // Two codes under money-code labels is a disagreement inside the message; it
  // is not evidence that the message issued one, so the void reading stands and
  // the target logic decides from there.
  const out = parseMoneycodeMessage(
    'voided\nMoney code: 2288341907\nMoney code: 5566778899',
  );
  assert.equal(out.status, STATUS.VOID_ACTION);
});
