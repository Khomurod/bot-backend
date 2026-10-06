'use strict';

/**
 * The owner's rule for the extra-week road bonus (2026-10-06), as a pure
 * function: decided after the home stay; home longer than the allowance → no
 * bonus; a trip over six weeks → a person checks it first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { decideRoadBonus, DECISIONS, REVIEW_AFTER_WEEKS } = require('../lib/homeTime/roadBonusDecision');

const leg = (over = {}) => ({
  bonus_usd: 200, days_on_road: 42, home_days: 3, return_to_road_at: '2026-10-05T12:00:00Z', ...over,
});

test('no bonus, nothing to decide', () => {
  assert.equal(decideRoadBonus(leg({ bonus_usd: 0 })), null);
  assert.equal(decideRoadBonus(null), null);
});

test('still at home: waiting, whatever else is true', () => {
  assert.equal(decideRoadBonus(leg({ return_to_road_at: null, days_on_road: 200 })).decision, DECISIONS.WAITING);
});

test('home within the allowance, trip within six weeks: released', () => {
  assert.deepEqual(decideRoadBonus(leg()), { decision: DECISIONS.RELEASED, reason: null });
  assert.equal(decideRoadBonus(leg({ home_days: 4 })).decision, DECISIONS.RELEASED, '4 is within 4');
  assert.equal(decideRoadBonus(leg({ days_on_road: REVIEW_AFTER_WEEKS * 7 })).decision, DECISIONS.RELEASED,
    'exactly six weeks is not longer than six weeks');
});

test('home longer than the allowance forfeits it — and that wins over a review', () => {
  const v = decideRoadBonus(leg({ home_days: 5, days_on_road: 117 }));
  assert.equal(v.decision, DECISIONS.FORFEITED);
  assert.equal(v.reason, 'stayed home 5 days; the limit is 4 days');
});

test('the allowance comes from settings', () => {
  assert.equal(decideRoadBonus(leg({ home_days: 5 }), { homeAllowanceDays: 7 }).decision, DECISIONS.RELEASED);
});

test('a trip over six weeks goes to a person', () => {
  const v = decideRoadBonus(leg({ days_on_road: 43 }));
  assert.equal(v.decision, DECISIONS.REVIEW);
  assert.match(v.reason, /43 days on the road is longer than 6 weeks/);
});

test('a home stay of unknown length is never released on a guess', () => {
  assert.equal(decideRoadBonus(leg({ home_days: null })).decision, DECISIONS.REVIEW);
});
