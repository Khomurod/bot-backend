/**
 * Unit — pure pickup-detail normalization + coordinate validation (blocker 3.1).
 * No database; proves the rules in isolation.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCoordinates, resolveActualPickup } = require('../services/trailerAgreements/pickupDetails');

test('parseCoordinates accepts a valid pair and both-empty', () => {
  assert.deepEqual(parseCoordinates('41.85', '-87.65'), { lat: 41.85, lng: -87.65 });
  assert.deepEqual(parseCoordinates('', ''), { lat: null, lng: null });
  assert.deepEqual(parseCoordinates(undefined, undefined), { lat: null, lng: null });
});

test('parseCoordinates rejects out-of-range and half-supplied pairs', () => {
  assert.throws(() => parseCoordinates('91', '0'), (e) => e.code === 'INVALID_COORDINATES');
  assert.throws(() => parseCoordinates('-91', '0'), (e) => e.code === 'INVALID_COORDINATES');
  assert.throws(() => parseCoordinates('0', '181'), (e) => e.code === 'INVALID_COORDINATES');
  assert.throws(() => parseCoordinates('0', '-181'), (e) => e.code === 'INVALID_COORDINATES');
  assert.throws(() => parseCoordinates('41.85', ''), (e) => e.code === 'INVALID_COORDINATES');
  assert.throws(() => parseCoordinates('', '-87.65'), (e) => e.code === 'INVALID_COORDINATES');
  assert.throws(() => parseCoordinates('abc', 'def'), (e) => e.code === 'INVALID_COORDINATES');
});

test('boundary coordinates are valid', () => {
  assert.deepEqual(parseCoordinates('90', '180'), { lat: 90, lng: 180 });
  assert.deepEqual(parseCoordinates('-90', '-180'), { lat: -90, lng: -180 });
});

test('resolveActualPickup falls back rather than blanking good values', () => {
  const item = {
    scheduled_pickup_at: new Date('2026-02-01T08:00:00Z'),
    pickup_location: 'Planned Yard',
    pickup_lat: 10, pickup_lng: 20,
  };
  // Nothing supplied → scheduled time + planned location, no coord override.
  const empty = resolveActualPickup({}, item);
  assert.equal(empty.actual_pickup_at.toISOString(), '2026-02-01T08:00:00.000Z');
  assert.equal(empty.actual_pickup_location, 'Planned Yard');
  assert.equal(empty.actual_pickup_lat, 10);

  // Blank strings must not overwrite the planned location.
  const blanked = resolveActualPickup({ pickup_location: '   ' }, item);
  assert.equal(blanked.actual_pickup_location, 'Planned Yard');

  // Supplied values win.
  const supplied = resolveActualPickup(
    { actual_pickup_at: '2026-03-01T12:00:00Z', pickup_location: 'Real Yard', pickup_lat: '1.5', pickup_lng: '2.5' },
    item,
  );
  assert.equal(supplied.actual_pickup_at.toISOString(), '2026-03-01T12:00:00.000Z');
  assert.equal(supplied.actual_pickup_location, 'Real Yard');
  assert.equal(supplied.actual_pickup_lat, 1.5);
  assert.equal(supplied.actual_pickup_lng, 2.5);
});

test('resolveActualPickup rejects an unparseable actual time', () => {
  assert.throws(
    () => resolveActualPickup({ actual_pickup_at: 'not-a-date' }, {}),
    (e) => e.code === 'INVALID_PICKUP_TIME',
  );
});
