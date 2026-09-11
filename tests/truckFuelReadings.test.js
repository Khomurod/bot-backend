/**
 * The baseline decision — the pure half of the fuel memory.
 *
 * THE DEFECT THIS FEATURE EXISTS TO CLOSE. `assessFuelRisk` has always carried
 * an abnormal-consumption branch that needs two readings of both fuel and
 * odometer. Its only caller handed it `fuelPercent: null, odometerMiles: null`
 * hard-coded, so the branch could never run. The feature was listed, tested at
 * the arithmetic level, and unreachable in production.
 *
 * What is asserted here is mostly the REFUSALS, because a burn rate computed
 * from the wrong pair of readings is worse than none: it is a confident number
 * that sends somebody to inspect a healthy truck.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const readings = require('../database/truckFuelReadings');

const T0 = '2026-09-20T06:00:00Z';
const hoursAfter = (h) => new Date(Date.parse(T0) + h * 3600000).toISOString();

const stored = (over = {}) => ({
  baselineFuelPercent: 90,
  baselineOdometerMiles: 100000,
  baselineAt: T0,
  baselineReason: 'first',
  ...over,
});

test('the first sight of a truck sets a baseline and compares against nothing', () => {
  const d = readings.decideBaseline(null, {
    fuelPercent: 80, odometerMiles: 100000, recordedAt: T0,
  });
  assert.equal(d.previous, null, 'one reading is not a comparison');
  assert.equal(d.reason, 'first');
  assert.equal(d.baseline.odometerMiles, 100000);
});

test('twenty minutes and four miles later there is still nothing to say', () => {
  const d = readings.decideBaseline(stored(), {
    fuelPercent: 89, odometerMiles: 100004, recordedAt: hoursAfter(0.33),
  });
  assert.equal(d.previous, null,
    'a 1% drop over 4 miles is a 25%-per-100-miles burn rate made of rounding error');
  assert.equal(d.reason, 'accumulating');
  assert.equal(d.baseline.odometerMiles, 100000, 'and the window keeps growing');
});

test('past the minimum distance the baseline becomes comparable', () => {
  const d = readings.decideBaseline(stored(), {
    fuelPercent: 70, odometerMiles: 100120, recordedAt: hoursAfter(3),
  });
  assert.deepEqual(d.previous, { fuelPercent: 90, odometerMiles: 100000 });
  assert.equal(d.reason, 'comparable');
  assert.equal(d.baseline.odometerMiles, 100000, 'the window is not reset while it is still useful');
});

test('a long window restarts once it has been judged', () => {
  const d = readings.decideBaseline(stored(), {
    fuelPercent: 20, odometerMiles: 100450, recordedAt: hoursAfter(9),
  });
  assert.deepEqual(d.previous, { fuelPercent: 90, odometerMiles: 100000 },
    'this pass still gets its comparison');
  assert.equal(d.reason, 'advanced');
  assert.equal(d.baseline.odometerMiles, 100450, 'and the next one measures the next tank');
  assert.equal(d.baseline.reason, 'distance');
});

// ── the refusals ─────────────────────────────────────────────────────────────

test('a refuel resets the baseline instead of producing a burn rate', () => {
  const d = readings.decideBaseline(stored({ baselineFuelPercent: 30 }), {
    fuelPercent: 98, odometerMiles: 100300, recordedAt: hoursAfter(6),
  });
  assert.equal(d.previous, null,
    'fuel "used" across a fill-up is not a quantity; it is two different tanks');
  assert.equal(d.baseline.reason, 'refuel');
  assert.equal(d.baseline.fuelPercent, 98);
});

test('sensor drift upward is not mistaken for a fill-up', () => {
  const d = readings.decideBaseline(stored({ baselineFuelPercent: 60 }), {
    fuelPercent: 62, odometerMiles: 100200, recordedAt: hoursAfter(4),
  });
  assert.notEqual(d.baseline.reason, 'refuel',
    'a 2-point rise on a sloshing tank happens constantly and must not reset the window');
  assert.deepEqual(d.previous, { fuelPercent: 60, odometerMiles: 100000 });
});

test('an odometer that went backwards resets rather than computing a negative distance', () => {
  const d = readings.decideBaseline(stored(), {
    fuelPercent: 50, odometerMiles: 99000, recordedAt: hoursAfter(4),
  });
  assert.equal(d.previous, null);
  assert.equal(d.baseline.reason, 'reset');
});

test('an implausible odometer jump resets rather than reporting a heroic burn rate', () => {
  const d = readings.decideBaseline(stored(), {
    fuelPercent: 50, odometerMiles: 180000, recordedAt: hoursAfter(4),
  });
  assert.equal(d.previous, null, 'a different vehicle now answers to this unit number');
  assert.equal(d.baseline.reason, 'reset');
});

test('a baseline older than the stale window describes a different trip', () => {
  const d = readings.decideBaseline(stored(), {
    fuelPercent: 60, odometerMiles: 100300, recordedAt: hoursAfter(24 * 5),
  });
  assert.equal(d.previous, null,
    'five days of parking and one run are not a burn rate');
  assert.equal(d.baseline.reason, 'stale');
});

test('a missing reading is UNKNOWN — never zero, and never destructive', () => {
  const d = readings.decideBaseline(stored(), {
    fuelPercent: null, odometerMiles: 100300, recordedAt: hoursAfter(4),
  });
  assert.equal(d.previous, null);
  assert.equal(d.reason, 'incomplete_reading');
  assert.equal(d.baseline.odometerMiles, 100000,
    'a provider that drops a field for one pass must not cost the window being built');
});

test('a first sight with no fuel reading at all stores no baseline to compare against', () => {
  const d = readings.decideBaseline(null, {
    fuelPercent: null, odometerMiles: null, recordedAt: T0,
  });
  assert.equal(d.previous, null);
  assert.equal(d.baseline, null, 'nothing is invented to fill the hole');
});

test('a truck whose fuel rose but which is otherwise unchanged still stores the new level', () => {
  const d = readings.decideBaseline(stored({ baselineFuelPercent: 20 }), {
    fuelPercent: 95, odometerMiles: 100010, recordedAt: hoursAfter(1),
  });
  assert.equal(d.baseline.fuelPercent, 95);
  assert.equal(d.baseline.odometerMiles, 100010);
});
