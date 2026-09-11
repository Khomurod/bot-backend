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

test('THE FORMAT THIS APPLICATION\'S OWN CLIENTS EMIT IS RECOGNISED', () => {
  // `services/datatruckApiService.js` throws `Datatruck API 429: ...`, and
  // Drive HoS and Samsara use the same `API <status>:` shape. That message is
  // what reaches a worker's `last_error` after its retries are exhausted — so
  // leaving `API` out of the status-code markers meant the format MOST likely
  // to be classified was the one format the classifier could not read.
  assert.equal(classifyErrorKind('Datatruck API 429: too many'), 'rate_limited');
  assert.equal(classifyErrorKind('Drive HoS API 401: bad key'), 'permission');
  assert.equal(classifyErrorKind('Samsara API 403: forbidden'), 'permission');
  assert.equal(classifyErrorKind('Datatruck API 404: no such load'), 'not_found');
});

test('and adding it did not reopen the id problem', () => {
  // The marker has to be adjacent, so a sentence that merely mentions an API
  // and happens to contain a number is still `other`.
  assert.equal(classifyErrorKind('could not read group 429'), 'other');
  assert.equal(classifyErrorKind('the API could not read road_history 404'), 'other');
  assert.equal(classifyErrorKind('api 500 something'), 'other');
});

// ── the two commonest `other`s, given names ──────────────────────────────────
//
// A critical worker sat at sixty consecutive failures and the only thing any
// public surface could say was "the message is on the What is running screen".
// `other` is the category that answers nothing, and in this application the two
// things most likely to land in it are a value the database refused and a
// stored secret that will not open. Both are now named — and both categories
// are still words from the fixed list, so nothing from the message travels.

test('a value the database refused is named, and the value does not travel', () => {
  for (const message of [
    'invalid input syntax for type integer: "NaN"',
    'value too long for type character varying(64)',
    'date/time field value out of range: "2027-13-45"',
    'numeric field overflow',
    'invalid byte sequence for encoding "UTF8": 0x00',
  ]) {
    const kind = classifyErrorKind(message);
    assert.equal(kind, 'bad_value', message);
    assert.ok(!describeErrorKind(kind).includes('NaN'));
    assert.ok(!describeErrorKind(kind).includes('64'));
    assert.ok(!describeErrorKind(kind).includes('varying'));
  }
});

test('a secret that will not decrypt is named rather than left as other', () => {
  for (const message of [
    'Unsupported state or unable to authenticate data',
    'error:1C800064:Provider routines::bad decrypt',
    'wrong final block length',
  ]) {
    assert.equal(classifyErrorKind(message), 'decrypt', message);
  }
});

test('a refused value is not mistaken for a schema problem', () => {
  // `column ... does not exist` is a code bug; `invalid input syntax` is a data
  // bug. Different afternoons, and the more specific pattern must still win.
  assert.equal(classifyErrorKind('column "unit" does not exist'), 'missing_column');
  assert.equal(classifyErrorKind('relation "x" does not exist'), 'missing_table');
});
