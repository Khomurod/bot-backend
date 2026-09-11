'use strict';

/**
 * Grading a decision after the fact, and when that may undo it.
 *
 * THE PROPERTY THIS FILE GUARDS: somebody else changing a value is NOT a
 * reason to change it back. It is information — a human disagreed — and it is
 * recorded as `contradicted`. But reverting there would mean software and a
 * person taking turns overwriting each other, and the software would win
 * because it never gets bored.
 *
 * And the second: `not_checked` is an HONEST answer. Grading an unverifiable
 * action `confirmed` because nothing objected would manufacture a track record
 * out of nothing — and `lib/decisions/sources.js` reads exactly that record to
 * decide how much to trust a source.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { OUTCOMES, compareWritten, sameValue, shouldRollBack } = require('../lib/decisions/verification');

// ── comparing what was written against what is there ────────────────────────

test('every written value still in place is CONFIRMED', () => {
  const out = compareWritten({
    wrote: { return_to_road_at: '2026-09-01T10:00:00Z', home_days: 3 },
    current: { return_to_road_at: '2026-09-01T10:00:00Z', home_days: 3 },
  });
  assert.equal(out.outcome, OUTCOMES.CONFIRMED);
  assert.equal(out.changedBy, 'nobody');
});

test('a changed value is CONTRADICTED, and the reason names the field', () => {
  const out = compareWritten({
    wrote: { return_to_road_at: '2026-09-01T10:00:00Z', home_days: 3 },
    current: { return_to_road_at: '2026-09-04T10:00:00Z', home_days: 3 },
  });
  assert.equal(out.outcome, OUTCOMES.CONTRADICTED);
  assert.equal(out.changedBy, 'someone');
  assert.deepEqual(out.fields, ['return_to_road_at']);
  assert.match(out.detail, /return_to_road_at no longer holds/);
});

test('a vanished subject is EXPIRED, not contradicted', () => {
  const out = compareWritten({ wrote: { a: 1 }, current: null });
  assert.equal(out.outcome, OUTCOMES.EXPIRED,
    'a row that was deleted tells us nothing about whether our change was right');
});

test('NOTHING RECORDED MEANS NOT_CHECKED, never confirmed', () => {
  for (const wrote of [null, {}, undefined]) {
    const out = compareWritten({ wrote, current: { a: 1 } });
    assert.equal(out.outcome, OUTCOMES.NOT_CHECKED,
      'grading it confirmed because nothing objected would manufacture a track '
      + 'record out of nothing, and the reliability model reads that record');
  }
});

test('a field the live read did not return is skipped rather than failed', () => {
  const out = compareWritten({ wrote: { a: 1, b: 2 }, current: { a: 1 } });
  assert.equal(out.outcome, OUTCOMES.CONFIRMED,
    'absence from the projection is the reader not asking, not the value changing');
});

test('timestamps compare by instant, not by spelling', () => {
  assert.equal(sameValue('2026-09-01T10:00:00Z', '2026-09-01T10:00:00.000Z'), true);
  assert.equal(sameValue('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'), false);
});

test('numbers compare across string and number forms', () => {
  assert.equal(sameValue(3, '3'), true);
  assert.equal(sameValue(3, '4'), false);
});

test('null and undefined are the same absence; null and a value are not', () => {
  assert.equal(sameValue(null, undefined), true);
  assert.equal(sameValue(null, 0), false);
});

// ── when an automatic rollback is allowed ───────────────────────────────────

const safe = { key: 'x', autoRevert: true };
const unsafe = { key: 'y', autoRevert: false };
const contradictedByUs = { outcome: OUTCOMES.CONTRADICTED, changedBy: 'nobody' };

test('A PERSON CHANGING IT IS NEVER A REASON TO CHANGE IT BACK', () => {
  const out = shouldRollBack({
    verdict: { outcome: OUTCOMES.CONTRADICTED, changedBy: 'someone' }, action: safe,
  });
  assert.equal(out.rollBack, false);
  assert.match(out.why, /arguing with them/);
});

test('an action that has not declared itself safe is never undone automatically', () => {
  assert.equal(shouldRollBack({ verdict: contradictedByUs, action: unsafe }).rollBack, false);
  assert.equal(shouldRollBack({ verdict: contradictedByUs, action: null }).rollBack, false);
});

test('nothing but CONTRADICTED is a reason to undo anything', () => {
  for (const outcome of [OUTCOMES.CONFIRMED, OUTCOMES.EXPIRED, OUTCOMES.NOT_CHECKED]) {
    const out = shouldRollBack({ verdict: { outcome, changedBy: 'nobody' }, action: safe });
    assert.equal(out.rollBack, false, `${outcome} is not a reason`);
  }
});

test('an already-reverted correction is not reverted again', () => {
  const out = shouldRollBack({ verdict: contradictedByUs, action: safe, alreadyReverted: true });
  assert.equal(out.rollBack, false);
  // A second revert is not idempotent — it is a re-application of the thing we
  // undid, which would put the wrong value back.
  assert.match(out.why, /already been reverted/);
});

test('all four conditions together DO allow a rollback, and say why', () => {
  const out = shouldRollBack({ verdict: contradictedByUs, action: safe });
  assert.equal(out.rollBack, true);
  assert.match(out.why, /no longer holds/);
});

test('BUT `compareWritten` CANNOT PRODUCE THAT VERDICT — so no rollback fires today', () => {
  // The verdict above was hand-built. This asserts the thing that actually
  // matters: every contradiction the real comparison can reach carries
  // `changedBy: 'someone'`, which the guard refuses.
  //
  // Found by trying to write a test that drove a rollback end to end and
  // discovering it could not be done. A path that LOOKS live and is not is the
  // defect this repository keeps finding, so it is recorded rather than
  // quietly left to be discovered again.
  const reachable = [
    compareWritten({ wrote: { a: 1 }, current: { a: 2 } }),
    compareWritten({ wrote: { a: 1, b: 2 }, current: { a: 1, b: 9 } }),
    compareWritten({ wrote: { at: '2026-01-01T00:00:00Z' }, current: { at: '2026-02-01T00:00:00Z' } }),
  ];
  for (const verdict of reachable) {
    assert.equal(verdict.outcome, OUTCOMES.CONTRADICTED);
    assert.equal(verdict.changedBy, 'someone',
      'the comparison cannot tell WHO changed a value, so it must assume a person');
    assert.equal(shouldRollBack({ verdict, action: safe }).rollBack, false);
  }

  // The guard stays because its case is real and simply not detectable yet: a
  // correction whose values are intact but whose justifying evidence has
  // evaporated. Detecting that means re-deriving the evidence, which is a
  // second decision engine and out of scope here.
});

test('the verdict is plain data throughout', () => {
  const out = shouldRollBack({ verdict: contradictedByUs, action: safe });
  for (const v of Object.values(out)) assert.notEqual(typeof v, 'function');
});
