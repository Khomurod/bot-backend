'use strict';

/**
 * lib/phone/e164 — the two shapes a phone number has to take here.
 *
 * These cases are the production bug, written down. Recruiter numbers are
 * stored exactly as an admin typed them, and the SMS sender used to hand that
 * string to RingCentral as `from`:
 *
 *   InvalidParameter / MSG-245
 *   Parameter [from] value [(470) 480-4679] is invalid
 *   [Cannot find the phone number which belongs to user]
 *
 * So every input below is a real spelling seen in production, and the
 * assertions are about the value that would actually reach RingCentral.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { toE164, phoneKey, sameNumber } = require('../lib/phone/e164');

// The three recruiters whose sends were rejected, as their rows really read.
const PRODUCTION_FORMS = [
  ['(470) 480-4679', '+14704804679'],
  ['(470) 419-4110', '+14704194110'],
  ['4702400064', '+14702400064'],
  ['470-419-4110', '+14704194110'],
  ['+14702400064', '+14702400064'],
];

test('every production spelling becomes the same sendable E.164 number', () => {
  for (const [stored, expected] of PRODUCTION_FORMS) {
    assert.equal(toE164(stored), expected, `${stored} must send as ${expected}`);
  }
});

test('an already-correct number is left exactly as it is', () => {
  // The pre-existing fixtures and the shared company number must not move.
  assert.equal(toE164('+15550001111'), '+15550001111');
  assert.equal(toE164('+14704804679'), '+14704804679');
});

test('the country code is added only when it is missing', () => {
  assert.equal(toE164('4704804679'), '+14704804679', '10 digits → assume +1');
  assert.equal(toE164('14704804679'), '+14704804679', '11 with a leading 1 → just add +');
  assert.equal(toE164('+1 (470) 480-4679'), '+14704804679', 'punctuation dropped, + kept');
});

test('a stated country code is trusted, never re-derived as +1', () => {
  // The one case where assuming North America would be wrong.
  assert.equal(toE164('+44 20 7946 0958'), '+442079460958');
  assert.equal(toE164('+61 2 9374 4000'), '+61293744000');
});

test('anything that cannot be dialled returns an empty string, not a guess', () => {
  // '' is what makes the caller fall back to a number that works. A
  // half-normalized string would instead reach RingCentral and fail there.
  for (const junk of ['', '   ', null, undefined, 'not a phone', '470480', '+1', '+', '0']) {
    assert.equal(toE164(junk), '', `${JSON.stringify(junk)} must not produce an address`);
  }
});

test('a number with an extension glued on is refused rather than guessed at', () => {
  // 4704804679 x12 → 13 digits. Sending the first 10 and dropping the rest, or
  // sending all 13, are both wrong; we cannot know which was meant.
  assert.equal(toE164('4704804679 x12'), '');
  assert.equal(toE164('470-480-4679 ext. 101'), '');
});

test('non-string input does not throw', () => {
  assert.equal(toE164(4704804679), '+14704804679', 'a number literal still works');
  assert.equal(toE164({}), '');
  assert.equal(toE164([]), '');
});

// ── phoneKey: comparison only ──

test('phoneKey makes every spelling of one number compare equal', () => {
  const forms = ['(470) 480-4679', '470-480-4679', '4704804679', '14704804679', '+14704804679'];
  const keys = new Set(forms.map(phoneKey));
  assert.deepEqual([...keys], ['4704804679'], 'all five spellings share one key');
});

test('phoneKey refuses anything too short to be a phone number', () => {
  // An extension is not a comparable phone number: treating '104' as a key is
  // how an extension silently "matches" someone's line.
  for (const short of ['104', '101', '4704', '', null]) {
    assert.equal(phoneKey(short), '', `${JSON.stringify(short)} is not comparable`);
  }
});

test('a phoneKey is never sendable — the two helpers do not overlap', () => {
  // Guards against the original confusion: the key has no country code, so
  // handing it to RingCentral as `from` fails exactly like the raw column did.
  const key = phoneKey('(470) 480-4679');
  assert.equal(key, '4704804679');
  assert.ok(!key.startsWith('+'), 'a key must never look like an address');
  assert.notEqual(key, toE164('(470) 480-4679'));
});

// ── sameNumber ──

test('sameNumber compares across formats', () => {
  assert.ok(sameNumber('(470) 480-4679', '+14704804679'));
  assert.ok(sameNumber('4702400064', '+1 470-240-0064'));
  assert.ok(!sameNumber('+14704804679', '+14704194110'));
});

test('two unusable values are never "the same number"', () => {
  // Otherwise an empty column would look like a match for anything.
  assert.ok(!sameNumber('', ''));
  assert.ok(!sameNumber(null, undefined));
  assert.ok(!sameNumber('nonsense', 'other nonsense'));
  assert.ok(!sameNumber('104', '104'));
});
