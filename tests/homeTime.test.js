const test = require('node:test');
const assert = require('node:assert');
const {
  computeNextEligibleHomeTime,
  parseDriverStatus,
  computeRoadBonus,
  homeTimePolicyApplies,
  wholeDaysBetween,
  newlyCrossedExtraWeeks,
} = require('../services/homeTimeConstants');

test('parseDriverStatus reads Home / Ready / Rolling in many shapes', () => {
  assert.strictEqual(parseDriverStatus('Status: Home'), 'home');
  assert.strictEqual(parseDriverStatus('status home'), 'home');
  assert.strictEqual(parseDriverStatus('🏠 Status - Home please'), 'home');
  assert.strictEqual(parseDriverStatus('Status: Ready'), 'road');
  assert.strictEqual(parseDriverStatus('STATUS: ROLLING'), 'road');
  assert.strictEqual(parseDriverStatus('Status: Ready to roll'), 'road');
  assert.strictEqual(parseDriverStatus('Driver update — Status: Rolling now'), 'road');
});

test('parseDriverStatus ignores ordinary chatter (no "status" keyword)', () => {
  assert.strictEqual(parseDriverStatus('almost home'), null);
  assert.strictEqual(parseDriverStatus('ready when you are'), null);
  assert.strictEqual(parseDriverStatus(''), null);
  assert.strictEqual(parseDriverStatus(null), null);
  assert.strictEqual(parseDriverStatus('rolling out the new tires'), null);
});

test('wholeDaysBetween floors and never goes negative', () => {
  assert.strictEqual(wholeDaysBetween('2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z'), 7);
  assert.strictEqual(wholeDaysBetween('2026-01-01T00:00:00Z', '2026-01-08T23:00:00Z'), 7);
  assert.strictEqual(wholeDaysBetween('2026-01-08T00:00:00Z', '2026-01-01T00:00:00Z'), 0);
});

test('wholeDaysBetween accepts JS Date inputs (Postgres timestamptz columns)', () => {
  const start = new Date('2026-06-08T00:00:00Z');
  const end = new Date('2026-06-26T00:00:00Z');
  assert.strictEqual(wholeDaysBetween(start, end), 18);
  assert.strictEqual(wholeDaysBetween(start, '2026-06-26T00:00:00Z'), 18);
  assert.strictEqual(wholeDaysBetween(start.getTime(), end.getTime()), 18);
});

test('computeRoadBonus works with JS Date inputs', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const end = new Date('2026-02-05T00:00:00Z');
  const r = computeRoadBonus(start, end, { roadAllowanceWeeks: 4, bonusPerWeek: 100 });
  assert.deepStrictEqual([r.daysOnRoad, r.exceededWeeks, r.bonusUsd], [35, 1, 100]);
});

test('computeRoadBonus: only FULL extra weeks count (4-week / $100 default)', () => {
  const opts = { roadAllowanceWeeks: 4, bonusPerWeek: 100 };

  let r = computeRoadBonus('2026-01-01T00:00:00Z', '2026-01-28T00:00:00Z', opts);
  assert.deepStrictEqual([r.daysOnRoad, r.exceededWeeks, r.bonusUsd], [27, 0, 0]);

  r = computeRoadBonus('2026-01-01T00:00:00Z', '2026-01-29T00:00:00Z', opts);
  assert.deepStrictEqual([r.daysOnRoad, r.exceededWeeks, r.bonusUsd], [28, 0, 0]);

  r = computeRoadBonus('2026-01-01T00:00:00Z', '2026-02-05T00:00:00Z', opts);
  assert.deepStrictEqual([r.daysOnRoad, r.exceededWeeks, r.bonusUsd], [35, 1, 100]);

  r = computeRoadBonus('2026-01-01T00:00:00Z', '2026-02-11T00:00:00Z', opts);
  assert.deepStrictEqual([r.daysOnRoad, r.exceededWeeks, r.bonusUsd], [41, 1, 100]);

  r = computeRoadBonus('2026-01-01T00:00:00Z', '2026-02-12T00:00:00Z', opts);
  assert.deepStrictEqual([r.daysOnRoad, r.exceededWeeks, r.bonusUsd], [42, 2, 200]);
});

test('computeRoadBonus respects custom allowance and bonus amount', () => {
  const r = computeRoadBonus('2026-01-01T00:00:00Z', '2026-01-30T00:00:00Z', {
    roadAllowanceWeeks: 2,
    bonusPerWeek: 150,
  });
  assert.deepStrictEqual([r.daysOnRoad, r.exceededWeeks, r.bonusUsd], [29, 2, 300]);
});

test('homeTimePolicyApplies: company drivers only', () => {
  assert.strictEqual(homeTimePolicyApplies('company_driver'), true);
  assert.strictEqual(homeTimePolicyApplies('owner'), false);
  assert.strictEqual(homeTimePolicyApplies(null), false);
});

test('computeRoadBonus tracks owner operators without awarding the company bonus', () => {
  const r = computeRoadBonus('2026-01-01T00:00:00Z', '2026-02-12T00:00:00Z', {
    roadAllowanceWeeks: 4,
    bonusPerWeek: 100,
    driverType: 'owner',
  });
  assert.deepStrictEqual(
    [r.daysOnRoad, r.exceededWeeks, r.bonusUsd, r.policyApplies, r.overLimit],
    [42, 2, 0, false, false]
  );
});

test('computeNextEligibleHomeTime returns the exact 4-week home-time date for company drivers', () => {
  const r = computeNextEligibleHomeTime('2026-01-01T00:00:00Z', {
    roadAllowanceWeeks: 4,
    driverType: 'company_driver',
  });
  assert.deepStrictEqual(r, {
    eligibleAtIso: '2026-01-29T00:00:00.000Z',
    eligibleDate: '2026-01-29',
  });
});

test('computeNextEligibleHomeTime returns null for owner operators and invalid dates', () => {
  assert.deepStrictEqual(
    computeNextEligibleHomeTime('2026-01-01T00:00:00Z', { roadAllowanceWeeks: 4, driverType: 'owner' }),
    { eligibleAtIso: null, eligibleDate: null }
  );
  assert.deepStrictEqual(
    computeNextEligibleHomeTime('not-a-date', { roadAllowanceWeeks: 4, driverType: 'company_driver' }),
    { eligibleAtIso: null, eligibleDate: null }
  );
});

test('newlyCrossedExtraWeeks: nothing owed once notified catches up to exceeded', () => {
  assert.deepStrictEqual(newlyCrossedExtraWeeks(0, 0), []);
  assert.deepStrictEqual(newlyCrossedExtraWeeks(1, 1), []);
  assert.deepStrictEqual(newlyCrossedExtraWeeks(2, 2), []);
});

test('newlyCrossedExtraWeeks: the 5th week (1st extra week) owes notification 1', () => {
  assert.deepStrictEqual(newlyCrossedExtraWeeks(1, 0), [1]);
});

test('newlyCrossedExtraWeeks: catches up every week missed in one pass', () => {
  assert.deepStrictEqual(newlyCrossedExtraWeeks(3, 0), [1, 2, 3]);
  assert.deepStrictEqual(newlyCrossedExtraWeeks(3, 1), [2, 3]);
});

test('newlyCrossedExtraWeeks: never goes backwards or negative', () => {
  assert.deepStrictEqual(newlyCrossedExtraWeeks(1, 3), []);
  assert.deepStrictEqual(newlyCrossedExtraWeeks(-1, -1), []);
});
