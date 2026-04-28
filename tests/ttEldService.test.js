const test = require('node:test');
const assert = require('node:assert/strict');

const { findUnitByTruckNumber } = require('../services/ttEldService');

test('tt findUnitByTruckNumber matches normalized truck numbers', () => {
  const units = [
    { truck_number: '008', timestamp: '2026-04-28T10:00:00Z' },
    { truck_number: '2614', timestamp: '2026-04-28T10:00:00Z' },
  ];

  assert.equal(findUnitByTruckNumber(units, '8').truck_number, '008');
  assert.equal(findUnitByTruckNumber(units, '02614').truck_number, '2614');
});

test('tt findUnitByTruckNumber returns newest unit when duplicates exist', () => {
  const units = [
    { truck_number: '2614', timestamp: '2026-04-28T09:59:00Z', id: 1 },
    { truck_number: '2614', timestamp: '2026-04-28T10:01:00Z', id: 2 },
  ];
  const found = findUnitByTruckNumber(units, '2614');
  assert.equal(found.id, 2);
});

test('tt findUnitByTruckNumber returns null when no match exists', () => {
  const units = [{ truck_number: '311', timestamp: '2026-04-28T10:01:00Z' }];
  assert.equal(findUnitByTruckNumber(units, '2614'), null);
});
