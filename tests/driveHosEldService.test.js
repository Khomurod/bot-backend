const test = require('node:test');
const assert = require('node:assert/strict');

const { findVehicleByUnit } = require('../services/driveHosEldService');

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
