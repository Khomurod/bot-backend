/**
 * Fuel risk, and the one rule that decides whether this feature survives
 * contact with the fleet: A MISSING READING IS NOT A LOW ONE.
 *
 * Most of these trucks do not report fuel. Samsara returns a percentage only
 * for vehicles whose gateway reads the engine bus. A rule that read absence as
 * zero would alert on the entire fleet on its first pass, and the feature would
 * be switched off the same day. Every threshold here therefore requires a real
 * number, and absence produces silence.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { RISKS, assessFuelRisk, estimateRangeMiles, DEFAULTS } = require('../lib/fuel/risk');

const NOW = '2026-09-20T18:00:00Z';
const at = (mins) => new Date(Date.parse(NOW) - mins * 60000).toISOString();

const HERE = { lat: 41.00, lng: -87.00 };
/** Roughly 210 miles north. */
const FAR_STATION = { stationLat: 44.05, stationLng: -87.00, stationName: 'Pilot 442' };
/** Roughly 14 miles north. */
const NEAR_STATION = { stationLat: 41.20, stationLng: -87.00, stationName: 'Pilot 442' };

const pos = (over = {}) => ({ ...HERE, speedMph: 60, at: at(5), ...over });
const run = (over = {}) => assessFuelRisk({ nowIso: NOW, ...over });
const kinds = (v) => v.risks.map((r) => r.kind);

// ── absence is silence ───────────────────────────────────────────────────────

test('a truck that reports no fuel at all raises nothing', () => {
  const v = run({ position: pos(), alert: FAR_STATION });
  assert.deepEqual(kinds(v), []);
  assert.equal(v.facts.fuelReported, false);
});

test('"no reading" and "an empty tank" are never the same value', () => {
  assert.equal(estimateRangeMiles(null, DEFAULTS), null);
  assert.equal(estimateRangeMiles(0, DEFAULTS), 0);
  const unknown = run({ position: pos({ fuelPercent: null }) });
  const empty = run({ position: pos({ fuelPercent: 0 }) });
  assert.deepEqual(kinds(unknown), []);
  assert.deepEqual(kinds(empty), [RISKS.LOW_FUEL]);
});

test('"can it reach the stop" needs BOTH a reading and a distance', () => {
  // No fuel reading: the question cannot be asked, so it is not answered.
  assert.deepEqual(kinds(run({ position: pos(), alert: FAR_STATION })), []);
  // No station: nothing to reach.
  assert.deepEqual(kinds(run({ position: pos({ fuelPercent: 60 }) })), []);
});

// ── the tank ─────────────────────────────────────────────────────────────────

test('a low tank is a warning; a critical one is serious', () => {
  assert.equal(run({ position: pos({ fuelPercent: 12 }) }).risks[0].severity, 'warning');
  assert.equal(run({ position: pos({ fuelPercent: 6 }) }).risks[0].severity, 'serious');
});

test('a comfortable tank raises nothing at all', () => {
  assert.deepEqual(kinds(run({ position: pos({ fuelPercent: 70 }) })), []);
});

test('the estimate travels with the numbers it came from, so it can be argued with', () => {
  const v = run({ position: pos({ fuelPercent: 12 }) });
  assert.match(v.risks[0].detail, /miles of range/);
  assert.equal(v.facts.tankGallons, DEFAULTS.tankGallons);
  assert.equal(v.facts.milesPerGallon, DEFAULTS.milesPerGallon);
  assert.equal(v.facts.rangeMiles, estimateRangeMiles(12, DEFAULTS));
});

// ── reaching the assigned stop ───────────────────────────────────────────────

test('a stop further away than the remaining range is serious', () => {
  const v = run({ position: pos({ fuelPercent: 12 }), alert: FAR_STATION });
  assert.ok(kinds(v).includes(RISKS.CANNOT_REACH_STOP));
  assert.equal(v.risks[0].severity, 'serious');
  assert.match(v.risks[0].detail, /miles away, about \d+ miles of range/);
});

test('a stop comfortably inside the range raises nothing about reaching it', () => {
  const v = run({ position: pos({ fuelPercent: 60 }), alert: FAR_STATION });
  assert.equal(kinds(v).includes(RISKS.CANNOT_REACH_STOP), false);
});

test('a truck already AT the stop is not warned about reaching it', () => {
  const v = run({
    position: pos({ fuelPercent: 6, lat: 41.20, lng: -87.00 }), alert: NEAR_STATION,
  });
  assert.equal(kinds(v).includes(RISKS.CANNOT_REACH_STOP), false, 'it is standing on the forecourt');
  assert.ok(kinds(v).includes(RISKS.LOW_FUEL), 'the tank is still the tank');
});

// ── going past it ────────────────────────────────────────────────────────────

test('distance alone never means "passed" — it has to have been CLOSER before', () => {
  // A truck 200 miles from a station it has not reached yet looks identical to
  // one 200 miles past it. Without the earlier reading there is no question.
  const v = run({ position: pos({ fuelPercent: 60 }), alert: FAR_STATION });
  assert.equal(kinds(v).includes(RISKS.PASSED_STOP), false);
});

test('closing on the stop and then moving away IS reported', () => {
  const v = run({
    position: pos({ fuelPercent: 60, lat: 41.35, lng: -87.00 }),
    alert: NEAR_STATION,
    previous: { milesToStation: 4 },
  });
  assert.ok(kinds(v).includes(RISKS.PASSED_STOP));
  assert.equal(v.facts.movingAway, true);
  assert.match(v.risks.find((r) => r.kind === RISKS.PASSED_STOP).detail, /last check/);
});

test('still approaching is not "moving away"', () => {
  const v = run({
    position: pos({ fuelPercent: 60, lat: 41.10, lng: -87.00 }),
    alert: NEAR_STATION,
    previous: { milesToStation: 30 },
  });
  assert.equal(kinds(v).includes(RISKS.PASSED_STOP), false);
  assert.equal(v.facts.movingAway, false);
});

// ── an instruction from last trip ────────────────────────────────────────────

test('an old instruction on a truck nowhere near it is flagged, gently', () => {
  const v = run({
    position: pos({ fuelPercent: 60 }),
    alert: { ...FAR_STATION, createdAt: at(60 * 40) },
  });
  const stale = v.risks.find((r) => r.kind === RISKS.INSTRUCTION_STALE);
  assert.ok(stale);
  assert.equal(stale.severity, 'info', 'a guess about staleness is not worth waking somebody');
});

test('an old instruction on a truck that is close to it is NOT flagged', () => {
  const v = run({
    position: pos({ fuelPercent: 60, lat: 41.15, lng: -87.00 }),
    alert: { ...NEAR_STATION, createdAt: at(60 * 40) },
  });
  assert.equal(kinds(v).includes(RISKS.INSTRUCTION_STALE), false, 'it is still on its way there');
});

// ── burn rate ────────────────────────────────────────────────────────────────

test('a burn rate needs two readings of BOTH fuel and distance', () => {
  // A percentage drop with no miles behind it is a truck that idled overnight,
  // not one burning badly.
  const idled = run({
    position: pos({ fuelPercent: 40, odometerMiles: 100000 }),
    previous: { fuelPercent: 70, odometerMiles: 100000 },
  });
  assert.equal(kinds(idled).includes(RISKS.ABNORMAL_BURN), false);

  const noOdometer = run({
    position: pos({ fuelPercent: 40 }),
    previous: { fuelPercent: 70 },
  });
  assert.equal(kinds(noOdometer).includes(RISKS.ABNORMAL_BURN), false);
});

test('a steep drop over real miles is reported', () => {
  const v = run({
    position: pos({ fuelPercent: 40, odometerMiles: 100200 }),
    previous: { fuelPercent: 90, odometerMiles: 100000 },
  });
  assert.ok(kinds(v).includes(RISKS.ABNORMAL_BURN));
  assert.equal(v.facts.milesSinceLastReading, 200);
  assert.equal(v.facts.burnPercentPer100Miles, 25);
});

test('an ordinary burn over real miles is not reported', () => {
  const v = run({
    position: pos({ fuelPercent: 70, odometerMiles: 100200 }),
    previous: { fuelPercent: 90, odometerMiles: 100000 },
  });
  assert.equal(kinds(v).includes(RISKS.ABNORMAL_BURN), false);
});

// ── stale position ───────────────────────────────────────────────────────────

test('a stale position stops every distance question, but not the tank', () => {
  const v = run({
    position: pos({ fuelPercent: 6, at: at(300) }), alert: FAR_STATION,
  });
  assert.equal(v.facts.gpsFresh, false);
  assert.equal(v.facts.milesToStation, null);
  assert.deepEqual(kinds(v), [RISKS.LOW_FUEL], 'the reading is still a reading');
});

// ── ordering ─────────────────────────────────────────────────────────────────

test('the most serious risk is first, because that is what gets read', () => {
  const v = run({
    position: pos({ fuelPercent: 6, odometerMiles: 100200 }),
    alert: { ...FAR_STATION, createdAt: at(60 * 40) },
    previous: { fuelPercent: 90, odometerMiles: 100000, milesToStation: 10 },
  });
  assert.ok(v.risks.length >= 3);
  assert.equal(v.risks[0].severity, 'serious');
  assert.equal(v.risks[v.risks.length - 1].severity, 'info');
});

test('only an actual NUMBER counts as a reading — Number(null) is 0, and that is the trap', () => {
  // This is the single most dangerous line in the module. `Number(null)`,
  // `Number('')` and `Number(false)` are all 0, so any threshold written with a
  // coercion would read "this truck does not report fuel" as "this truck is
  // empty" and alert on the entire fleet.
  for (const notAReading of [null, undefined, '', '0', '6', false, {}, []]) {
    const v = run({ position: pos({ fuelPercent: notAReading }) });
    assert.equal(v.facts.fuelReported, false, `${JSON.stringify(notAReading)} is not a reading`);
    assert.deepEqual(kinds(v), [], `${JSON.stringify(notAReading)} must raise nothing`);
  }
  // And a genuine zero IS a reading, and a serious one.
  const empty = run({ position: pos({ fuelPercent: 0 }) });
  assert.equal(empty.facts.fuelReported, true);
  assert.equal(empty.risks[0].severity, 'serious');
});
