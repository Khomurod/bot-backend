const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractUnitNumberFromGroupName,
  extractUnitNumberFromVehicleName,
  normalizeUnitNumber,
  computePingAgeMinutes,
  findVehicleByUnit,
} = require('../services/samsaraLocationService');

test('extractUnitNumberFromGroupName supports UNIT # pattern', () => {
  assert.equal(
    extractUnitNumberFromGroupName('WENZE UNIT # 4604 VALENTIN JOSEPH'),
    '4604'
  );
});

test('extractUnitNumberFromGroupName supports hash-only fallback', () => {
  assert.equal(
    extractUnitNumberFromGroupName('WENZE # 008 PRODNET LUBIN'),
    '008'
  );
});

test('extractUnitNumberFromVehicleName returns the first numeric token', () => {
  assert.equal(extractUnitNumberFromVehicleName('008 PRODNET LUBIN'), '008');
  assert.equal(extractUnitNumberFromVehicleName('UNIT 311 DRIVER'), '311');
});

test('normalizeUnitNumber strips non-digits and normalizes leading zeros', () => {
  assert.equal(normalizeUnitNumber('UNIT # 008'), '8');
  assert.equal(normalizeUnitNumber('4604'), '4604');
  assert.equal(normalizeUnitNumber('0000'), '0');
  assert.equal(normalizeUnitNumber('abc'), null);
});

test('computePingAgeMinutes floors elapsed minutes and clamps future pings to 0', () => {
  const now = new Date('2026-04-27T21:00:00Z');
  assert.equal(computePingAgeMinutes('2026-04-27T20:48:12Z', now), 11);
  assert.equal(computePingAgeMinutes('2026-04-27T21:00:10Z', now), 0);
});

test('findVehicleByUnit matches normalized unit and picks freshest gps timestamp', () => {
  const vehicles = [
    { id: 'v-old', name: '008 PRODNET LUBIN', gps: { time: '2026-04-27T20:30:00Z' } },
    { id: 'v-new', name: '8 PRODNET LUBIN', gps: { time: '2026-04-27T20:48:12Z' } },
    { id: 'v-other', name: '311 JEAN WALKENS', gps: { time: '2026-04-27T20:59:00Z' } },
  ];

  const match = findVehicleByUnit(vehicles, '0008');
  assert.ok(match);
  assert.equal(match.id, 'v-new');
});

test('findVehicleByUnit returns null when there is no unit match', () => {
  const vehicles = [{ id: 'v1', name: '311 JEAN WALKENS', gps: { time: '2026-04-27T20:59:00Z' } }];
  assert.equal(findVehicleByUnit(vehicles, '4604'), null);
});
