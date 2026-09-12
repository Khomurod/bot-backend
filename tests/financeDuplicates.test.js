/**
 * Was this money code already issued?
 *
 * The property that matters is WHICH CLAIM IS MADE. A repeated code is a fact;
 * a repeated amount to one person is a suspicion. Collapsing them into one
 * boolean would let the weekly report say "paid twice" when all it knows is
 * "two similar rows", so the two reasons are asserted separately throughout —
 * and the weaker one refuses to fire on incomplete evidence.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { REASON, DEFAULT_WINDOW_HOURS, decideDuplicate, normalisePerson } = require('../lib/finance/duplicates');

const EARLIER = [{
  id: 7,
  codeNormalized: '1234567890',
  amount: 500,
  issuedTo: 'Ivan P',
  issuedAt: '2026-09-12T10:00:00Z',
}];

test('nothing earlier means nothing is a duplicate', () => {
  const out = decideDuplicate({ codeNormalized: '1234567890', amount: 500 }, []);
  assert.equal(out, null);
});

test('the same code is same_code, and points at the row it repeats', () => {
  const out = decideDuplicate({ codeNormalized: '1234567890' }, EARLIER);
  assert.equal(out.reason, REASON.SAME_CODE);
  assert.equal(out.duplicateOfId, 7);
});

test('a repeated code is a duplicate however long ago it was — a code does not expire into being new', () => {
  const out = decideDuplicate(
    { codeNormalized: '1234567890', issuedAt: '2027-03-01T00:00:00Z' },
    EARLIER,
  );
  assert.equal(out.reason, REASON.SAME_CODE);
});

test('the same amount to the same person inside the window is only a suspicion', () => {
  const out = decideDuplicate({
    codeNormalized: '9999999999', amount: 500,
    issuedTo: 'Ivan P', issuedAt: '2026-09-12T18:00:00Z',
  }, EARLIER);
  assert.equal(out.reason, REASON.SAME_AMOUNT_RECIPIENT_WINDOW);
  assert.equal(out.duplicateOfId, 7);
  assert.match(out.detail, /72h/);
});

test('the recipient is matched on shape, not on exact punctuation', () => {
  const out = decideDuplicate({
    codeNormalized: '9999999999', amount: 500,
    issuedTo: 'ivan   p.', issuedAt: '2026-09-12T18:00:00Z',
  }, EARLIER);
  assert.equal(out.reason, REASON.SAME_AMOUNT_RECIPIENT_WINDOW);
});

test('outside the window it is not a duplicate at all', () => {
  const out = decideDuplicate({
    codeNormalized: '9999999999', amount: 500,
    issuedTo: 'Ivan P', issuedAt: '2026-09-30T18:00:00Z',
  }, EARLIER);
  assert.equal(out, null);
});

test('the window is configurable, and widening it changes the answer', () => {
  const candidate = {
    codeNormalized: '9999999999', amount: 500,
    issuedTo: 'Ivan P', issuedAt: '2026-09-20T10:00:00Z',
  };
  assert.equal(decideDuplicate(candidate, EARLIER), null);
  const wide = decideDuplicate(candidate, EARLIER, { windowHours: 24 * 30 });
  assert.equal(wide.reason, REASON.SAME_AMOUNT_RECIPIENT_WINDOW);
});

test('a different person is not a duplicate, however alike the rest is', () => {
  const out = decideDuplicate({
    codeNormalized: '9999999999', amount: 500,
    issuedTo: 'Bekzod S', issuedAt: '2026-09-12T11:00:00Z',
  }, EARLIER);
  assert.equal(out, null);
});

test('a different amount is not a duplicate', () => {
  const out = decideDuplicate({
    codeNormalized: '9999999999', amount: 501,
    issuedTo: 'Ivan P', issuedAt: '2026-09-12T11:00:00Z',
  }, EARLIER);
  assert.equal(out, null);
});

test('the weak signal refuses to fire on incomplete evidence', () => {
  // Each of these is missing exactly one of the three things the claim needs.
  // Guessing past any of them is how "two similar rows" becomes "paid twice".
  const complete = {
    codeNormalized: '9999999999', amount: 500,
    issuedTo: 'Ivan P', issuedAt: '2026-09-12T11:00:00Z',
  };
  assert.ok(decideDuplicate(complete, EARLIER), 'the complete case must match, or this test proves nothing');

  assert.equal(decideDuplicate({ ...complete, amount: null }, EARLIER), null, 'no amount');
  assert.equal(decideDuplicate({ ...complete, issuedTo: null }, EARLIER), null, 'no recipient');
  assert.equal(decideDuplicate({ ...complete, issuedAt: null }, EARLIER), null, 'no time');
  assert.equal(decideDuplicate({ ...complete, issuedAt: 'not a date' }, EARLIER), null, 'unreadable time');
  assert.equal(decideDuplicate({ ...complete, amount: 0 }, EARLIER), null, 'zero amount');
  assert.equal(decideDuplicate({ ...complete, amount: -500 }, EARLIER), null, 'negative amount');
});

test('an earlier row with an unreadable time cannot be matched against', () => {
  const out = decideDuplicate({
    codeNormalized: '9999999999', amount: 500,
    issuedTo: 'Ivan P', issuedAt: '2026-09-12T11:00:00Z',
  }, [{ ...EARLIER[0], issuedAt: null }]);
  assert.equal(out, null);
});

test('a code match wins over an amount match, because it is the stronger claim', () => {
  const earlier = [
    { id: 1, codeNormalized: '5555555555', amount: 500, issuedTo: 'Ivan P', issuedAt: '2026-09-12T10:00:00Z' },
    { id: 2, codeNormalized: '1234567890', amount: 999, issuedTo: 'Someone Else', issuedAt: '2026-09-12T10:00:00Z' },
  ];
  const out = decideDuplicate({
    codeNormalized: '1234567890', amount: 500,
    issuedTo: 'Ivan P', issuedAt: '2026-09-12T11:00:00Z',
  }, earlier);
  assert.equal(out.reason, REASON.SAME_CODE);
  assert.equal(out.duplicateOfId, 2);
});

test('it never throws, whatever it is handed', () => {
  for (const junk of [null, undefined, 0, 'x', {}, []]) {
    assert.doesNotThrow(() => decideDuplicate(junk, EARLIER));
    assert.doesNotThrow(() => decideDuplicate(EARLIER[0], junk));
  }
});

test('normalisePerson folds case, punctuation and spacing, and nothing else', () => {
  assert.equal(normalisePerson('Ivan  P.'), 'ivan p');
  assert.equal(normalisePerson('IVAN-P'), 'ivan p');
  assert.equal(normalisePerson(null), '');
  assert.notEqual(normalisePerson('Ivan P'), normalisePerson('Ivan B'));
});

test('the default window is stated, not implied', () => {
  assert.equal(DEFAULT_WINDOW_HOURS, 72);
});
