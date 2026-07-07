const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractUnitNumberFromGroupName,
  extractUnitNumberFromVehicleName,
  vehicleNameMatchesUnit,
  normalizeUnitNumber,
  computePingAgeMinutes,
  findVehicleByUnit,
  selectVehicleByUnit,
} = require('../services/samsaraLocationService');
const { extractDriverNameFromGroupTitle } = require('../services/driverGroupTitle');

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

test('findVehicleByUnit prefers name-matching vehicle when driver hint provided', () => {
  const vehicles = [
    {
      id: 'v-stale',
      name: '2908 NIKE AUGUSTE',
      gps: { time: '2026-05-19T16:05:00Z' },
    },
    {
      id: 'v-current',
      name: '2908 TESFAMARIAM YOSIEF',
      gps: { time: '2026-05-19T15:00:00Z' },
    },
  ];
  const hint = extractDriverNameFromGroupTitle('WENZE UNIT # 2908 TESFAMARIAM YOSIEF');
  const match = findVehicleByUnit(vehicles, '2908', { driverNameHint: hint });
  assert.equal(match.id, 'v-current');
});

test('vehicleNameMatchesUnit matches a unit token anywhere in the label', () => {
  assert.equal(vehicleNameMatchesUnit('008 PRODNET LUBIN', '8'), true);
  // unit is NOT the first number (year prefix) — old first-token logic missed this
  assert.equal(vehicleNameMatchesUnit('2021 Freightliner 305', '305'), true);
  assert.equal(vehicleNameMatchesUnit('UNIT # 305', '305'), true);
  assert.equal(vehicleNameMatchesUnit('311 JEAN WALKENS', '305'), false);
  assert.equal(vehicleNameMatchesUnit('', '305'), false);
});

test('findVehicleByUnit matches when the unit is not the first number in the name', () => {
  const vehicles = [
    { id: 'year-first', name: '2021 Freightliner 305', gps: { time: '2026-04-27T20:00:00Z' } },
  ];
  const match = findVehicleByUnit(vehicles, '305');
  assert.ok(match);
  assert.equal(match.id, 'year-first');
});

test('findVehicleByUnit with single mismatch still returns vehicle', () => {
  const vehicles = [
    { id: 'v1', name: '2908 NIKE AUGUSTE', gps: { time: '2026-05-19T16:00:00Z' } },
  ];
  const match = findVehicleByUnit(vehicles, '2908', {
    driverNameHint: 'TESFAMARIAM YOSIEF',
  });
  assert.equal(match.id, 'v1');
});

// ── selectVehicleByUnit: duplicate unit-number disambiguation ──

const DUP_UNIT_VEHICLES = [
  { id: 'v-nike', name: '2908 NIKE AUGUSTE', gps: { time: '2026-05-19T16:05:00Z' } }, // fresher
  { id: 'v-tesfa', name: '2908 TESFAMARIAM YOSIEF', gps: { time: '2026-05-19T15:00:00Z' } },
];

test('selectVehicleByUnit: single unit match is never ambiguous', () => {
  const sel = selectVehicleByUnit([DUP_UNIT_VEHICLES[0]], '2908', { driverNameHint: 'NIKE AUGUSTE' });
  assert.equal(sel.ambiguous, false);
  assert.equal(sel.vehicle.id, 'v-nike');
  assert.equal(sel.reason, 'unique_unit');
});

test('selectVehicleByUnit: duplicate unit + matching group driver selects the right vehicle', () => {
  const sel = selectVehicleByUnit(DUP_UNIT_VEHICLES, '2908', { driverNameHint: 'TESFAMARIAM YOSIEF' });
  assert.equal(sel.ambiguous, false);
  assert.equal(sel.vehicle.id, 'v-tesfa'); // NOT the fresher NIKE truck
  assert.equal(sel.reason, 'group_driver_match');
});

test('selectVehicleByUnit: duplicate unit + no matching group driver is AMBIGUOUS', () => {
  const sel = selectVehicleByUnit(DUP_UNIT_VEHICLES, '2908', { driverNameHint: 'SOMEONE ELSE' });
  assert.equal(sel.ambiguous, true);
  assert.equal(sel.vehicle, null);
  assert.equal(sel.candidates.length, 2);
});

test('selectVehicleByUnit: duplicate unit + no group driver hint is AMBIGUOUS (never freshest-GPS guess)', () => {
  const sel = selectVehicleByUnit(DUP_UNIT_VEHICLES, '2908');
  assert.equal(sel.ambiguous, true);
  assert.equal(sel.vehicle, null);
  assert.equal(sel.reason, 'duplicate_unit_no_group_driver');
});

test('selectVehicleByUnit: same driver appearing twice (stale + fresh) picks freshest, not ambiguous', () => {
  const vehicles = [
    { id: 'v-old', name: '008 PRODNET LUBIN', gps: { time: '2026-04-27T20:30:00Z' } },
    { id: 'v-new', name: '8 PRODNET LUBIN', gps: { time: '2026-04-27T20:48:12Z' } },
  ];
  const sel = selectVehicleByUnit(vehicles, '0008');
  assert.equal(sel.ambiguous, false);
  assert.equal(sel.vehicle.id, 'v-new');
  assert.equal(sel.reason, 'same_driver_duplicate');
});
