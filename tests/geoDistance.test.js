'use strict';

/**
 * lib/geo/distance.js — the single great-circle implementation.
 *
 * There used to be two: an asin/6 371 000 m version in services/routeGeometry.js
 * and an atan2/3 958.8 mi version in services/etaRoutingService.js. Four
 * consumers between them answer "is the truck there yet" — route completion,
 * tracking start, fuel-stop proximity and ETA remaining distance — so these
 * tests pin that the two call shapes agree with each other and that the known
 * reference distances still come out right.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  haversineMeters, haversineMiles, METERS_PER_MILE, EARTH_RADIUS_M,
} = require('../lib/geo/distance');

// Chicago O'Hare → Dallas/Fort Worth, a lane this fleet actually runs.
const ORD = [41.9742, -87.9073];
const DFW = [32.8998, -97.0403];

test('a known long lane matches the published great-circle distance', () => {
  // ORD→DFW is ~1290 km / ~802 statute miles great-circle.
  const meters = haversineMeters(ORD, DFW);
  assert.ok(meters > 1_285_000 && meters < 1_295_000, `got ${meters} m`);
  const miles = haversineMiles(ORD[0], ORD[1], DFW[0], DFW[1]);
  assert.ok(miles > 798 && miles < 806, `got ${miles} mi`);
});

test('the two call shapes are the same measurement in different units', () => {
  const meters = haversineMeters(ORD, DFW);
  const miles = haversineMiles(ORD[0], ORD[1], DFW[0], DFW[1]);
  assert.ok(Math.abs(miles - meters / METERS_PER_MILE) < 1e-9,
    'haversineMiles must be haversineMeters converted, not a second formula');
});

test('short distances — the range route completion actually decides on', () => {
  // ~100 m north of a point: one degree of latitude is ~111.2 km.
  const a = [41.9742, -87.9073];
  const b = [41.9742 + 0.0009, -87.9073];
  const meters = haversineMeters(a, b);
  assert.ok(meters > 95 && meters < 105, `got ${meters} m`);
});

test('identical points are zero, not NaN', () => {
  assert.equal(haversineMeters(ORD, ORD), 0);
  assert.equal(haversineMiles(ORD[0], ORD[1], ORD[0], ORD[1]), 0);
});

test('antipodal points do not produce NaN through the sqrt clamp', () => {
  const meters = haversineMeters([0, 0], [0, 180]);
  assert.ok(Number.isFinite(meters), 'must be finite');
  assert.ok(Math.abs(meters - Math.PI * EARTH_RADIUS_M) < 1, 'half the circumference');
});

test('order does not matter', () => {
  assert.equal(haversineMeters(ORD, DFW), haversineMeters(DFW, ORD));
});

test('route control and the shared module use one meters-per-mile constant', () => {
  const routeControl = require('../services/routeControl/constants');
  assert.equal(routeControl.METERS_PER_MILE, METERS_PER_MILE);
});

test('routeGeometry still exposes haversineMeters for its own consumers', () => {
  const geometry = require('../services/routeGeometry');
  assert.equal(typeof geometry.haversineMeters, 'function');
  assert.equal(geometry.haversineMeters(ORD, DFW), haversineMeters(ORD, DFW));
});
