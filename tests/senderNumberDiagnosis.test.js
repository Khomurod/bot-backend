'use strict';

/**
 * The Diagnose button's number verdict.
 *
 * This step exists to predict a rejected send, and its old form got that
 * exactly backwards for the case that was actually broken: it compared the
 * stored number and RingCentral's numbers through a last-ten-digits key, so a
 * recruiter stored as `(470) 480-4679` against RingCentral's `+14704804679`
 * reported **"Number match: OK"** while every lead text was rejected with
 * MSG-245. An operator looking at a green panel had no reason to suspect the
 * number.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { diagnoseSenderNumber } = require('../server/routes/recruiter/senderNumberDiagnosis');

test('a punctuated number that RingCentral owns now reads as OK — because it now sends', async () => {
  // The production case. It is genuinely fine NOW (the send normalizes), and
  // the message says what will actually go out so the two can be reconciled.
  const verdict = diagnoseSenderNumber({
    storedNumber: '(470) 480-4679',
    extensionPhoneNumbers: ['+14704804679'],
  });
  assert.equal(verdict.verdict, 'ok');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.sendable, '+14704804679');
  assert.match(verdict.detail, /sends as \+14704804679/, 'names the number that will leave');
});

test('an identical stored spelling says so plainly, with no redundant aside', async () => {
  const verdict = diagnoseSenderNumber({
    storedNumber: '+14704804679',
    extensionPhoneNumbers: ['+14704804679'],
  });
  assert.equal(verdict.verdict, 'ok');
  assert.match(verdict.detail, /belongs to this RingCentral user\.$/);
  assert.doesNotMatch(verdict.detail, /sends as/);
});

test('a number that cannot be sent from at all is a finding, not a match question', async () => {
  // This is the state that produces `recruiter_not_configured` and never even
  // reaches RingCentral, so "does the extension own it" is the wrong question.
  for (const junk of ['', '   ', 'ask Bob', '470480', '4704804679 x12']) {
    const verdict = diagnoseSenderNumber({
      storedNumber: junk,
      extensionPhoneNumbers: ['+14704804679'],
    });
    assert.equal(verdict.verdict, 'unsendable', `${JSON.stringify(junk)} must be reported`);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.label, 'Sender number');
    assert.match(verdict.detail, /not a phone number a text can be sent from/);
    // An operator must not come away thinking they have to retype it "properly".
    assert.match(verdict.detail, /any format works/);
  }
});

test('a line the extension does not own is still caught', async () => {
  const verdict = diagnoseSenderNumber({
    storedNumber: '(470) 419-4110',
    extensionPhoneNumbers: ['+14704804679', '+15557779999'],
  });
  assert.equal(verdict.verdict, 'not_owned');
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /not \(470\) 419-4110/);
  assert.match(verdict.detail, /\+14704804679, \+15557779999/, 'says what it DOES own');
});

test('a stray country code is reported as a tidy-up, not an outage', async () => {
  // Last ten digits match, so it is the recruiter's line — and the send
  // self-corrects — but the stored value disagrees with RingCentral and should
  // be fixed before it confuses someone.
  const verdict = diagnoseSenderNumber({
    storedNumber: '+44 (470) 480-4679',
    extensionPhoneNumbers: ['+14704804679'],
  });
  assert.equal(verdict.verdict, 'spelling');
  assert.equal(verdict.ok, false, 'surfaced, because a human should reconcile it');
  assert.equal(verdict.canonical, '+14704804679');
  assert.match(verdict.detail, /corrected automatically/, 'and says leads are not affected');
});

test('unreadable extension numbers are skipped, not reported as a mismatch', async () => {
  // The phone-number read needs a permission that is not always granted.
  // Guessing "mismatch" from no data would send an operator chasing nothing.
  const verdict = diagnoseSenderNumber({
    storedNumber: '(470) 480-4679',
    extensionPhoneNumbers: [],
  });
  assert.equal(verdict.verdict, 'unreadable');
  assert.equal(verdict.ok, true);
  assert.match(verdict.detail, /not readable/);
});

test('an unsendable number is reported even when nothing can be compared', async () => {
  // Order matters: the stored value being unusable is knowable without
  // RingCentral, and it is the more actionable of the two.
  const verdict = diagnoseSenderNumber({ storedNumber: 'n/a', extensionPhoneNumbers: [] });
  assert.equal(verdict.verdict, 'unsendable');
});

test('a missing or malformed extension list does not throw', async () => {
  for (const numbers of [undefined, null, 'not an array', [null, '', undefined]]) {
    const verdict = diagnoseSenderNumber({
      storedNumber: '(470) 480-4679',
      extensionPhoneNumbers: numbers,
    });
    assert.equal(verdict.verdict, 'unreadable');
  }
});
