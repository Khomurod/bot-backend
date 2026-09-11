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

// ── a bare number is not a status code ──────────────────────────────────────

/**
 * THE WRONG-CATEGORY FAILURE THIS FILE WARNS ABOUT, COMMITTED BY THIS FILE.
 *
 * The first version matched `429`, `404`, `401` and `403` anywhere in the
 * message. This application is full of numeric identifiers — group ids, road
 * history ids, unit numbers — so "could not read group 429" classified as
 * rate-limited and "road_history 404 is missing" as not-found.
 *
 * I believed one of those readings about a live production failure before
 * noticing it could be an id. A category is only worth publishing if it is
 * right, which is the whole argument for `other`.
 */
test('AN ID THAT LOOKS LIKE A STATUS CODE IS NOT ONE', () => {
  const ids = [
    'could not read group 429',
    'road_history 404 is missing',
    'driver_units row 403 is open twice',
    'unit 401 has no person',
    'load 500 has no group',
    'person 502 merged into 503',
  ];
  for (const message of ids) {
    assert.equal(classifyErrorKind(message), 'other',
      `"${message}" is about a row, not an HTTP response`);
  }
});

test('and a genuine status code is still recognised, in the shapes they arrive in', () => {
  const real = [
    ['HTTP 429 Too Many Requests', 'rate_limited'],
    ['429 Too Many Requests', 'rate_limited'],
    ['status 429', 'rate_limited'],
    ['rate limit exceeded', 'rate_limited'],
    ['quota exceeded for this project', 'rate_limited'],
    ['request failed with status 404', 'not_found'],
    ['404 Not Found', 'not_found'],
    ['401 Unauthorized', 'permission'],
    ['status: 403', 'permission'],
    ['permission denied for table groups', 'permission'],
  ];
  for (const [message, expected] of real) {
    assert.equal(classifyErrorKind(message), expected, `"${message}"`);
  }
});

test('a word-form match needs no number at all', () => {
  assert.equal(classifyErrorKind('Not Found'), 'not_found');
  assert.equal(classifyErrorKind('forbidden'), 'permission');
});
