'use strict';

/**
 * What kind of failure, in a word that cannot contain a value.
 *
 * WHY THIS IS NOT JUST PUBLISHING THE MESSAGE. A critical worker reached
 * eighteen consecutive failures in production and the only thing any public
 * surface could say was the count. The message itself can quote a value a
 * database rejected, and `/api/health` is read by Render and an uptime monitor.
 *
 * So the message stays private and its CLASSIFICATION travels — and the
 * property that makes that safe is asserted here: every value this can return
 * comes from a fixed list, so no input, however hostile, can push a driver's
 * name or a row's contents onto a public endpoint.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { KINDS, classifyErrorKind, describeErrorKind } = require('../lib/operations/errorKind');

test('NO INPUT CAN PRODUCE A VALUE OUTSIDE THE FIXED LIST', () => {
  const hostile = [
    'relation "drivers_secret" does not exist',
    'duplicate key value violates unique constraint "x" DETAIL: Key (phone)=(+15551234567) exists',
    'connect ETIMEDOUT 10.0.0.1:5432',
    'JOHN DOE is not a function',
    '{"apiKey":"sk-live-abcdef"} is not defined',
    'a'.repeat(10000),
    '',
    '   ',
    'völlig unbekannt',
    '<script>alert(1)</script>',
  ];
  for (const input of hostile) {
    const kind = classifyErrorKind(input);
    assert.ok(KINDS.includes(kind), `"${String(input).slice(0, 30)}" → ${kind} is in the list`);
    // The decisive property: nothing from the input survives into the output.
    assert.equal(kind.length < 20, true);
  }
});

test('a message quoting a phone number classifies without carrying it', () => {
  const kind = classifyErrorKind(
    'duplicate key value violates unique constraint DETAIL: Key (phone)=(+15551234567) already exists'
  );
  assert.equal(kind, 'constraint');
  assert.equal(kind.includes('5551234567'), false);
  assert.equal(describeErrorKind(kind).includes('5551234567'), false);
});

test('the categories that matter are told apart', () => {
  assert.equal(classifyErrorKind('relation "x" does not exist'), 'missing_table');
  assert.equal(classifyErrorKind('column "y" does not exist'), 'missing_column');
  assert.equal(classifyErrorKind('connect ECONNREFUSED'), 'connection');
  assert.equal(classifyErrorKind('connect ETIMEDOUT'), 'timeout');
  assert.equal(classifyErrorKind('permission denied for table x'), 'permission');
  assert.equal(classifyErrorKind('429 Too Many Requests'), 'rate_limited');
  assert.equal(classifyErrorKind('foo is not a function'), 'type_error');
  assert.equal(classifyErrorKind('bar is not defined'), 'reference_error');
});

test('AN UNRECOGNISED MESSAGE IS `other`, NOT THE NEAREST GUESS', () => {
  assert.equal(classifyErrorKind('the flux capacitor disengaged'), 'other',
    'a wrong category is worse than none, because somebody would go and look '
    + 'in the wrong place');
});

test('no error at all is null, which is not a kind', () => {
  assert.equal(classifyErrorKind(null), null);
  assert.equal(classifyErrorKind(undefined), null);
});

test('an Error object classifies by its message', () => {
  assert.equal(classifyErrorKind(new TypeError('x is not a function')), 'type_error');
});

test('every kind has a sentence, and no sentence leaks anything', () => {
  for (const kind of KINDS) {
    const said = describeErrorKind(kind);
    assert.ok(said && said.length > 5, `${kind} reads as a sentence`);
  }
  assert.equal(describeErrorKind('invented'), null);
});

test('the more specific pattern wins over the more general one', () => {
  // "does not exist" appears in both table and column messages; the column one
  // must not be swallowed by the table pattern.
  assert.equal(classifyErrorKind('column "return_to_road_at" does not exist'), 'missing_column');
});
