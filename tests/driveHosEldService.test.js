const test = require('node:test');
const assert = require('node:assert/strict');

const { findVehicleByUnit, extractVehicleArray } = require('../services/driveHosEldService');

test('findVehicleByUnit matches normalized unit numbers on the `number` field', () => {
  const vehicles = [
    { number: '008', timestamp: '2026-04-28T10:00:00Z' },
    { number: '2614', timestamp: '2026-04-28T10:00:00Z' },
  ];

  assert.equal(findVehicleByUnit(vehicles, '8').number, '008');
  assert.equal(findVehicleByUnit(vehicles, '02614').number, '2614');
});

test('findVehicleByUnit returns the freshest ping when duplicates exist', () => {
  const vehicles = [
    { number: '2614', timestamp: '2026-04-28T09:59:00Z', vehicle_id: 'a' },
    { number: '2614', timestamp: '2026-04-28T10:01:00Z', vehicle_id: 'b' },
  ];

  assert.equal(findVehicleByUnit(vehicles, '2614').vehicle_id, 'b');
});

test('findVehicleByUnit returns null when no unit matches', () => {
  const vehicles = [{ number: '100', timestamp: '2026-04-28T10:00:00Z' }];
  assert.equal(findVehicleByUnit(vehicles, '999'), null);
  assert.equal(findVehicleByUnit([], '100'), null);
  assert.equal(findVehicleByUnit(null, '100'), null);
});

test('findVehicleByUnit falls back to a unit token inside a free-form label', () => {
  const vehicles = [{ name: 'Truck 305 - Freightliner', timestamp: '2026-04-28T10:00:00Z' }];
  assert.equal(findVehicleByUnit(vehicles, '305').name, 'Truck 305 - Freightliner');
});

test('extractVehicleArray accepts the documented and alternate response shapes', () => {
  const rows = [{ number: '1' }];
  assert.deepEqual(extractVehicleArray(rows), rows);                 // bare array
  assert.deepEqual(extractVehicleArray({ data: rows }), rows);       // { data }
  assert.deepEqual(extractVehicleArray({ vehicles: rows }), rows);   // { vehicles }
  assert.deepEqual(extractVehicleArray({ result: rows }), rows);     // { result }
  assert.deepEqual(extractVehicleArray({ results: rows }), rows);    // { results }
  assert.deepEqual(extractVehicleArray({ data: { vehicles: rows } }), rows); // nested
});

test('extractVehicleArray returns null when no array can be found', () => {
  assert.equal(extractVehicleArray({ message: 'ok', total: 0 }), null);
  assert.equal(extractVehicleArray('nope'), null);
  assert.equal(extractVehicleArray(null), null);
});
