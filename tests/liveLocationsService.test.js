const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeNextStop,
  indexOrdersByDriver,
  indexOrdersByUnit,
  orderSortKey,
  resolveLocationForUnit,
  buildLocationFromSamsaraVehicle,
  buildLocationFromDriveHosVehicle,
  unitNumberForRow,
  STALE_MINUTES,
} = require('../services/liveLocationsService');

// ─── computeNextStop ──────────────────────────────────────────────────────────
test('computeNextStop returns pickup while its window is still upcoming', () => {
  const now = Date.now();
  const stop = computeNextStop({
    pickupAddress: '1 Origin St',
    deliveryAddress: '2 Dest Ave',
    pickupWindowEnd: new Date(now + 3_600_000).toISOString(),
    shipperName: 'Acme Shipper',
    receiverName: 'Beta Receiver',
  }, now);
  assert.equal(stop.nextStopType, 'pickup');
  assert.equal(stop.nextStopAddress, '1 Origin St');
  assert.equal(stop.nextStopName, 'Acme Shipper');
});

test('computeNextStop switches to delivery once pickup window has passed', () => {
  const now = Date.now();
  const stop = computeNextStop({
    pickupAddress: '1 Origin St',
    deliveryAddress: '2 Dest Ave',
    pickupWindowEnd: new Date(now - 3_600_000).toISOString(),
    receiverName: 'Beta Receiver',
  }, now);
  assert.equal(stop.nextStopType, 'delivery');
  assert.equal(stop.nextStopAddress, '2 Dest Ave');
  assert.equal(stop.nextStopName, 'Beta Receiver');
});

test('computeNextStop returns null when there are no stop addresses', () => {
  assert.equal(computeNextStop({}, Date.now()), null);
  assert.equal(computeNextStop(null, Date.now()), null);
});

// ─── order ranking / indexing ─────────────────────────────────────────────────
test('orderSortKey prefers a not-yet-reached pickup over a past order', () => {
  const now = Date.now();
  const upcoming = { pickup_time: new Date(now + 3_600_000).toISOString() };
  const past = { delivery_time: new Date(now - 86_400_000).toISOString() };
  assert.ok(orderSortKey(upcoming, now) < orderSortKey(past, now));
});

test('indexOrdersByDriver keys the best order by normalized driver name', () => {
  const now = Date.now();
  const orders = [
    { id: 1, trip: { driver__full_name: 'John Doe' }, delivery_time: new Date(now - 86_400_000).toISOString() },
    { id: 2, trip: { driver__full_name: 'john  doe' }, pickup_time: new Date(now + 3_600_000).toISOString() },
  ];
  const idx = indexOrdersByDriver(orders, now);
  assert.equal(idx.get('john doe').id, 2); // upcoming pickup wins the tie
});

test('indexOrdersByUnit matches the unit token inside trip.truck__unit_number', () => {
  const now = Date.now();
  const orders = [
    { id: 10, trip: { truck__unit_number: '771 JAFAR' }, pickup_time: new Date(now + 3_600_000).toISOString() },
    { id: 11, trip: { truck__unit_number: '#314 CMP' }, pickup_time: new Date(now + 7_200_000).toISOString() },
  ];
  const idx = indexOrdersByUnit(orders, now);
  assert.equal(idx.get('771').id, 10);
  assert.equal(idx.get('314').id, 11); // "#314 CMP" normalizes to 314
});

test('computeNextStop carries structured coordinates through to the next stop', () => {
  const now = Date.now();
  const stop = computeNextStop({
    pickupAddress: '1 Origin St',
    deliveryAddress: '2 Dest Ave',
    pickupWindowEnd: new Date(now + 3_600_000).toISOString(),
    pickupLat: 41, pickupLng: -87,
    deliveryLat: 40, deliveryLng: -75,
  }, now);
  assert.equal(stop.nextStopType, 'pickup');
  assert.equal(stop.nextStopLat, 41);
  assert.equal(stop.nextStopLng, -87);
});

// ─── unit enumeration fallback ─────────────────────────────────────────────────
test('unitNumberForRow prefers the stored column', () => {
  assert.equal(unitNumberForRow({ unit_number: '0305', group_name: 'WENZE UNIT # 999 X' }), '305');
});

test('unitNumberForRow falls back to parsing the group title when column is empty', () => {
  assert.equal(unitNumberForRow({ unit_number: null, raw_group_title: 'WENZE UNIT # 2614 JOHN DOE' }), '2614');
  assert.equal(unitNumberForRow({ unit_number: '', group_name: 'WENZE # 008 PRODNET LUBIN' }), '8');
});

test('unitNumberForRow returns null when no unit can be derived', () => {
  assert.equal(unitNumberForRow({ unit_number: null, group_name: 'DISPATCH TEAM' }), null);
});

// ─── location normalization + provider priority ───────────────────────────────
test('buildLocationFromSamsaraVehicle normalizes gps fields and staleness', () => {
  const fresh = buildLocationFromSamsaraVehicle({
    gps: { latitude: 41.1, longitude: -87.1, time: new Date().toISOString(), speedMilesPerHour: 62.6, headingDegrees: 95 },
  });
  assert.equal(fresh.lat, 41.1);
  assert.equal(fresh.lng, -87.1);
  assert.equal(fresh.speedMph, 63);
  assert.equal(fresh.heading, 95);
  assert.equal(fresh.isStale, false);

  const stale = buildLocationFromSamsaraVehicle({
    gps: { latitude: 1, longitude: 2, time: new Date(Date.now() - (STALE_MINUTES + 5) * 60_000).toISOString() },
  });
  assert.equal(stale.isStale, true);
});

test('buildLocationFromSamsaraVehicle returns null without coordinates', () => {
  assert.equal(buildLocationFromSamsaraVehicle({ gps: {} }), null);
});

test('buildLocationFromDriveHosVehicle parses string coordinates', () => {
  const loc = buildLocationFromDriveHosVehicle({
    lat: '41.5', lon: '-87.5', speed: '55', timestamp: new Date().toISOString(),
  });
  assert.equal(loc.lat, 41.5);
  assert.equal(loc.lng, -87.5);
  assert.equal(loc.speedMph, 55);
});

test('resolveLocationForUnit honors Samsara → Factor → Leader priority', () => {
  const samsaraVehicle = { name: 'Truck 100', gps: { latitude: 1, longitude: 1, time: new Date().toISOString() } };
  const driveHosVehicle = { number: '100', lat: '2', lon: '2', timestamp: new Date().toISOString() };

  const bySamsara = resolveLocationForUnit(
    { samsara: [samsaraVehicle], factor: [driveHosVehicle], leader: null },
    '100', '',
  );
  assert.equal(bySamsara.provider, 'samsara');

  const byFactor = resolveLocationForUnit(
    { samsara: [], factor: [driveHosVehicle], leader: null },
    '100', '',
  );
  assert.equal(byFactor.provider, 'factor');

  const none = resolveLocationForUnit({ samsara: [], factor: [], leader: [] }, '100', '');
  assert.equal(none.provider, null);
  assert.equal(none.location, null);
});
