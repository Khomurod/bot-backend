'use strict';

/**
 * The AI's second opinion on a load alarm: it may keep a notice out of the
 * chat on a confident "bad data", and nothing else. It never sees a name, an
 * address or a coordinate, and its failure is the old behaviour exactly.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReviewPrompt, validateReview, decideFromReview, HOLD_CONFIDENCE,
} = require('../lib/loads/alarmReview');
const { reviewLoadAlarm, forgetReviews } = require('../services/loads/alarmReview');
const watcher = require('../services/loads/lifecycleWatch');
const { NOW, at, SHIPPER, ORDER, harness } = require('./helpers/loadWatchHarness');

const VERDICT = {
  phase: 'at_pickup',
  conflicts: ['board_says_delivered_but_the_truck_is_at_the_shipper'],
  facts: {
    boardStatus: 'delivered', milesToPickup: 1, milesToDelivery: 296, moving: false,
    gpsAgeMinutes: 5, sawPickup: true, sawDelivery: false,
  },
};

test('the prompt carries the facts and no name, address or coordinate', () => {
  const p = buildReviewPrompt({
    ...VERDICT,
    facts: { ...VERDICT.facts, loadIdentifier: 'L-77', lat: 41.88, lng: -87.63 },
  });
  assert.match(p, /Datatruck says delivered, but the truck is standing at the pickup/);
  assert.match(p, /Miles from the delivery: 296/);
  assert.doesNotMatch(p, /41\.88|-87\.63|L-77|board_says/);
});

test('only the declared shape passes', () => {
  assert.equal(validateReview('', { verdict: 'real_problem', confidence: 90, why: 'x' }), true);
  assert.notEqual(validateReview('', { verdict: 'delete_load', confidence: 90, why: 'x' }), true);
  assert.notEqual(validateReview('', { verdict: 'unsure', confidence: 120, why: 'x' }), true);
  assert.notEqual(validateReview('', { verdict: 'unsure', confidence: 50, why: ' ' }), true);
});

test('ONLY a confident "likely bad data" holds a notice back', () => {
  assert.equal(decideFromReview({ verdict: 'likely_bad_data', confidence: HOLD_CONFIDENCE, why: 'stale GPS' }).send, false);
  assert.equal(decideFromReview({ verdict: 'likely_bad_data', confidence: HOLD_CONFIDENCE - 1, why: 'maybe' }).send, true);
  const real = decideFromReview({ verdict: 'real_problem', confidence: 95, why: 'The truck never moved.' });
  assert.equal(real.send, true);
  assert.equal(real.line, "Wenze's read: The truck never moved.");
});

test('no review, or a malformed one, sends exactly as before', () => {
  assert.deepEqual(decideFromReview(null), { send: true, line: null, review: null });
  assert.equal(decideFromReview({ verdict: 'nonsense' }).send, true);
});

test('AI unavailable: the notice is sent and nothing is remembered', async () => {
  forgetReviews();
  let calls = 0;
  const deps = { runCapability: async () => { calls += 1; throw new Error('no provider'); } };
  const out = { state: { orderId: 'O1' }, verdict: VERDICT };
  assert.equal((await reviewLoadAlarm(out, '2026-10-06T10:00:00Z', deps)).send, true);
  await reviewLoadAlarm(out, '2026-10-06T10:10:00Z', deps);
  assert.equal(calls, 2, 'a failure is not cached — the next pass may have a provider');
});

test('one review per load, per disagreement, per day', async () => {
  forgetReviews();
  let calls = 0;
  const deps = {
    runCapability: async () => {
      calls += 1;
      return { parsed: { verdict: 'likely_bad_data', confidence: 90, why: 'GPS lag' } };
    },
  };
  const out = { state: { orderId: 'O2' }, verdict: VERDICT };
  await reviewLoadAlarm(out, '2026-10-06T10:00:00Z', deps);
  await reviewLoadAlarm(out, '2026-10-06T10:10:00Z', deps);
  assert.equal(calls, 1);
  await reviewLoadAlarm(out, '2026-10-07T10:00:00Z', deps);
  assert.equal(calls, 2, 'a new day is a new question');
});

// ── wired into the watch ─────────────────────────────────────────────────────

function conflicted(review) {
  const { deps, calls } = harness({
    orders: [{ ...ORDER, status: 'delivered' }],
    position: { ...SHIPPER, speedMph: 0, at: at(5) },
  });
  deps.reviewAlarm = async () => review;
  return { deps, calls };
}

test('a held alarm is NOT sent, but the finding is still filed with the review', async () => {
  const { deps, calls } = conflicted({
    send: false, line: null, review: { verdict: 'likely_bad_data', confidence: 90, why: 'GPS lag' },
  });
  const summary = await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(calls.notified.length, 0);
  assert.equal(summary.heldByAi, 1);
  assert.equal(calls.findings.length, 1);
  assert.equal(calls.findings[0].evidence.aiReview.verdict, 'likely_bad_data');
});

test('a confirmed alarm is sent with the one-sentence read', async () => {
  const { deps, calls } = conflicted({
    send: true, line: "Wenze's read: The truck has not moved in four hours.", review: { verdict: 'real_problem' },
  });
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(calls.notified.length, 1);
  assert.ok(calls.notified[0].lines.includes("Wenze's read: The truck has not moved in four hours."));
});

test('a review that throws costs nothing: the alarm goes out', async () => {
  const { deps, calls } = conflicted(null);
  deps.reviewAlarm = async () => { throw new Error('boom'); };
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(calls.notified.length, 1);
});

test('an alarm already said today is not reviewed again', async () => {
  const { deps } = conflicted(null);
  let reviewed = 0;
  deps.reviewAlarm = async () => { reviewed += 1; return null; };
  deps.notifications.noticeSentWithin = async () => true;
  await watcher.runLoadLifecycleCheck({ now: NOW, deps });
  assert.equal(reviewed, 0);
});
