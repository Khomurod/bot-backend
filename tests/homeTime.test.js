const test = require('node:test');
const assert = require('node:assert');
const {
  parseDriverStatus,
  computeRoadBonus,
  wholeDaysBetween,
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

test('computeRoadBonus: only FULL extra weeks count (4-week / $100 default)', () => {
  const opts = { roadAllowanceWeeks: 4, bonusPerWeek: 100 };

  // 27 days out → under the 28-day limit → no bonus.
  let r = computeRoadBonus('2026-01-01T00:00:00Z', '2026-01-28T00:00:00Z', opts);
  assert.deepStrictEqual([r.daysOnRoad, r.exceededWeeks, r.bonusUsd], [27, 0, 0]);

  // Exactly 28 days → at the limit → no bonus.
  r = computeRoadBonus('2026-01-01T00:00:00Z', '2026-01-29T00:00:00Z', opts);
  assert.deepStrictEqual([r.daysOnRoad, r.exceededWeeks, r.bonusUsd], [28, 0, 0]);

  // 35 days → 1 full extra week → $100.
  r = computeRoadBonus('2026-01-01T00:00:00Z', '2026-02-05T00:00:00Z', opts);
  assert.deepStrictEqual([r.daysOnRoad, r.exceededWeeks, r.bonusUsd], [35, 1, 100]);

  // 41 days → 13 extra days → still only 1 full week → $100.
  r = computeRoadBonus('2026-01-01T00:00:00Z', '2026-02-11T00:00:00Z', opts);
  assert.deepStrictEqual([r.daysOnRoad, r.exceededWeeks, r.bonusUsd], [41, 1, 100]);

  // 42 days → 2 full extra weeks → $200.
  r = computeRoadBonus('2026-01-01T00:00:00Z', '2026-02-12T00:00:00Z', opts);
  assert.deepStrictEqual([r.daysOnRoad, r.exceededWeeks, r.bonusUsd], [42, 2, 200]);
});

test('computeRoadBonus respects custom allowance and bonus amount', () => {
  // 2-week allowance, $150/week, out 29 days → 15 extra days → 2 full weeks → $300.
  const r = computeRoadBonus('2026-01-01T00:00:00Z', '2026-01-30T00:00:00Z', {
    roadAllowanceWeeks: 2,
    bonusPerWeek: 150,
  });
  assert.deepStrictEqual([r.daysOnRoad, r.exceededWeeks, r.bonusUsd], [29, 2, 300]);
});
