'use strict';

/**
 * What a reading is worth.
 *
 * THE PROPERTY THIS FILE EXISTS FOR: evidence quality may only LOWER a
 * confidence, never raise one. A system that could talk itself up would
 * eventually act on five weak agreements the way it acts on one strong one —
 * and five sources reading the same stale feed are not five pieces of
 * evidence, they are one counted five times.
 *
 * And the second: AN UNMEASURED SOURCE IS NOT AN UNRELIABLE ONE. "We have
 * never checked" and "we checked and it was wrong" are different facts, and
 * only the second may cost anything.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  describeSource, reliabilityOf, weighConfidence, soleSourceIsUnreliable, MIN_GRADED,
} = require('../lib/decisions/sources');

const NOW = '2026-09-11T12:00:00Z';
const minutesAgo = (n) => new Date(Date.parse(NOW) - n * 60000).toISOString();

// ── freshness is the caller's question, not a constant ──────────────────────

test('a reading inside the window is fresh; outside it is not', () => {
  const fresh = describeSource({ source: 'gps', at: minutesAgo(10), freshForMinutes: 60, now: NOW });
  const stale = describeSource({ source: 'gps', at: minutesAgo(90), freshForMinutes: 60, now: NOW });
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.ageMinutes, 10);
  assert.equal(stale.fresh, false);
});

test('THE SAME READING IS FRESH FOR ONE QUESTION AND STALE FOR ANOTHER', () => {
  const at = minutesAgo(50);
  assert.equal(describeSource({ source: 'gps', at, freshForMinutes: 45, now: NOW }).fresh, false);
  assert.equal(describeSource({ source: 'gps', at, freshForMinutes: 60, now: NOW }).fresh, true);
  // Which is why the window is named by the caller: a position goes stale in
  // minutes and a home-time request in days, and one constant cannot serve both.
});

test('A READING WITH NO TIMESTAMP IS NOT FRESH', () => {
  const s = describeSource({ source: 'board', at: null, freshForMinutes: 60, now: NOW });
  assert.equal(s.fresh, false);
  assert.equal(s.ageMinutes, null);
  // It might well be current. We cannot say so, and "cannot say" has to travel
  // as not-fresh or the caller silently treats an undated reading as current.
});

test('an unparseable timestamp is treated the same as none', () => {
  const s = describeSource({ source: 'board', at: 'last Tuesday', freshForMinutes: 60, now: NOW });
  assert.equal(s.fresh, false);
});

test('agrees is three-valued, and null is not disagreement', () => {
  assert.equal(describeSource({ source: 'a', agrees: null }).agrees, null);
  assert.equal(describeSource({ source: 'a', agrees: undefined }).agrees, null);
  assert.equal(describeSource({ source: 'a', agrees: false }).agrees, false);
});

// ── an unmeasured source is not an unreliable one ───────────────────────────

test('NO TRACK RECORD IS NOT A BAD TRACK RECORD', () => {
  const r = reliabilityOf({ graded: 0, confirmed: 0 });
  assert.equal(r.known, false);
  assert.equal(r.poor, false, 'never having been checked is not evidence against a source');
  assert.equal(r.agreementRate, null);
});

test('a record too short to mean anything is still no record', () => {
  const r = reliabilityOf({ graded: MIN_GRADED - 1, confirmed: 0 });
  assert.equal(r.known, false);
  assert.equal(r.poor, false, 'nought for four is a bad week, not a bad source');
});

test('a long enough BAD record is measured and marked poor', () => {
  const r = reliabilityOf({ graded: 10, confirmed: 3 });
  assert.equal(r.known, true);
  assert.equal(r.agreementRate, 0.3);
  assert.equal(r.poor, true);
});

test('a long enough GOOD record is measured and not poor', () => {
  const r = reliabilityOf({ graded: 10, confirmed: 9 });
  assert.equal(r.poor, false);
  assert.equal(r.agreementRate, 0.9);
});

// ── confidence only ever goes down ──────────────────────────────────────────

test('CONFIDENCE IS NEVER RAISED, however much agrees', () => {
  const sources = ['a', 'b', 'c', 'd', 'e'].map(
    (s) => describeSource({ source: s, at: minutesAgo(1), freshForMinutes: 60, agrees: true, now: NOW })
  );
  const out = weighConfidence({ base: 70, sources });
  assert.equal(out.confidence, 70,
    'five fresh agreeing sources do not make a 70 into a 90 — a system that '
    + 'could talk itself up would act on five weak agreements like one strong one');
});

test('a good measured record does not raise it either', () => {
  const sources = [describeSource({ source: 'gps', at: minutesAgo(1), freshForMinutes: 60, agrees: true, now: NOW }),
    describeSource({ source: 'board', at: minutesAgo(1), freshForMinutes: 60, agrees: true, now: NOW })];
  const out = weighConfidence({
    base: 60, sources, reliability: { gps: reliabilityOf({ graded: 50, confirmed: 50 }) },
  });
  assert.equal(out.confidence, 60);
});

test('stale readings cost proportionally, and say so in words', () => {
  const sources = [
    describeSource({ source: 'a', at: minutesAgo(90), freshForMinutes: 60, agrees: true, now: NOW }),
    describeSource({ source: 'b', at: minutesAgo(1), freshForMinutes: 60, agrees: true, now: NOW }),
  ];
  const out = weighConfidence({ base: 90, sources });
  assert.equal(out.confidence, 70, 'half stale, so half of the 40-point penalty');
  assert.match(out.reasons.join(' '), /1 of 2 readings were stale/);
});

test('one lone source is corroborated by nothing, and loses a little for it', () => {
  const sources = [describeSource({ source: 'a', at: minutesAgo(1), freshForMinutes: 60, agrees: true, now: NOW })];
  const out = weighConfidence({ base: 80, sources });
  assert.equal(out.confidence, 70);
  assert.match(out.reasons.join(' '), /nothing corroborates it/);
});

test('a MEASURED poor source costs, and the reason names the number', () => {
  const sources = [
    describeSource({ source: 'flaky', at: minutesAgo(1), freshForMinutes: 60, agrees: true, now: NOW }),
    describeSource({ source: 'gps', at: minutesAgo(1), freshForMinutes: 60, agrees: true, now: NOW }),
  ];
  const out = weighConfidence({
    base: 90, sources, reliability: { flaky: reliabilityOf({ graded: 20, confirmed: 4 }) },
  });
  assert.equal(out.confidence, 65);
  assert.match(out.reasons.join(' '), /flaky has agreed with the outcome 20% of the time over 20/);
});

test('an UNMEASURED source costs nothing', () => {
  const sources = [
    describeSource({ source: 'new', at: minutesAgo(1), freshForMinutes: 60, agrees: true, now: NOW }),
    describeSource({ source: 'gps', at: minutesAgo(1), freshForMinutes: 60, agrees: true, now: NOW }),
  ];
  const out = weighConfidence({
    base: 90, sources, reliability: { new: reliabilityOf({ graded: 2, confirmed: 0 }) },
  });
  assert.equal(out.confidence, 90);
});

test('confidence never goes below zero', () => {
  const sources = [describeSource({ source: 'flaky', at: null, freshForMinutes: 60, agrees: true })];
  const out = weighConfidence({
    base: 10, sources, reliability: { flaky: reliabilityOf({ graded: 20, confirmed: 1 }) },
  });
  assert.equal(out.confidence, 0);
});

test('no base means no confidence — not a zero to compare against a threshold', () => {
  const out = weighConfidence({ base: null, sources: [] });
  assert.equal(out.confidence, null);
});

// ── the floor, which is not a penalty ───────────────────────────────────────

test('A MEASURED-POOR SOURCE MAY NOT BE THE ONLY THING ACTED ON', () => {
  const sources = [describeSource({ source: 'flaky', at: minutesAgo(1), freshForMinutes: 60, agrees: true, now: NOW })];
  const reliability = { flaky: reliabilityOf({ graded: 20, confirmed: 4 }) };
  assert.equal(soleSourceIsUnreliable(sources, reliability), true,
    '"the one source saying yes is the one we have measured as usually wrong" '
    + 'is not weaker evidence, it is an absence of it');
});

test('and it is fine as one voice among several', () => {
  const sources = [
    describeSource({ source: 'flaky', at: minutesAgo(1), freshForMinutes: 60, agrees: true, now: NOW }),
    describeSource({ source: 'gps', at: minutesAgo(1), freshForMinutes: 60, agrees: true, now: NOW }),
  ];
  const reliability = { flaky: reliabilityOf({ graded: 20, confirmed: 4 }) };
  assert.equal(soleSourceIsUnreliable(sources, reliability), false);
});

test('a lone source with no record is not blocked', () => {
  const sources = [describeSource({ source: 'new', at: minutesAgo(1), freshForMinutes: 60, agrees: true, now: NOW })];
  assert.equal(soleSourceIsUnreliable(sources, {}), false);
});

test('everything here is pure data — nothing weighs anything by acting', () => {
  const s = describeSource({ source: 'a', at: minutesAgo(1), freshForMinutes: 60, agrees: true, now: NOW });
  for (const v of Object.values(s)) assert.notEqual(typeof v, 'function');
  const out = weighConfidence({ base: 50, sources: [s] });
  assert.equal(JSON.stringify(out).includes('function'), false);
});
