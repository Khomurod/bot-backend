const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractDriverNameFromGroupTitle,
  extractDriverNameFromVehicleLabel,
  driverNamesMatch,
  scoreVehicleNameMatch,
  buildLocationSummaryLines,
} = require('../services/driverGroupTitle');

test('extractDriverNameFromGroupTitle parses WENZE unit group titles', () => {
  assert.equal(
    extractDriverNameFromGroupTitle('WENZE UNIT # 2908 TESFAMARIAM YOSIEF (COMPANY DRIVER)'),
    'TESFAMARIAM YOSIEF'
  );
  assert.equal(
    extractDriverNameFromGroupTitle('WENZE UNIT # 4604 VALENTIN JOSEPH'),
    'VALENTIN JOSEPH'
  );
});

test('extractDriverNameFromVehicleLabel strips unit prefix', () => {
  assert.equal(
    extractDriverNameFromVehicleLabel('2908 NIKE AUGUSTE', '2908'),
    'NIKE AUGUSTE'
  );
  assert.equal(
    extractDriverNameFromVehicleLabel('008 PRODNET LUBIN', '008'),
    'PRODNET LUBIN'
  );
});

test('driverNamesMatch detects same and different drivers', () => {
  assert.equal(driverNamesMatch('TESFAMARIAM YOSIEF', 'NIKE AUGUSTE'), false);
  assert.equal(driverNamesMatch('VALENTIN JOSEPH', '4604 VALENTIN JOSEPH'), true);
  assert.equal(driverNamesMatch('JOHN SMITH', 'JOHN SMITH'), true);
});

test('scoreVehicleNameMatch ranks closer names higher', () => {
  const good = scoreVehicleNameMatch('TESFAMARIAM YOSIEF', '2908 TESFAMARIAM YOSIEF');
  const bad = scoreVehicleNameMatch('TESFAMARIAM YOSIEF', '2908 NIKE AUGUSTE');
  assert.ok(good > bad);
});

test('buildLocationSummaryLines includes mismatch warning', () => {
  const lines = buildLocationSummaryLines({
    source: 'Samsara',
    location: {
      unitNumber: '2908',
      assignedDriverName: 'TESFAMARIAM YOSIEF',
      vehicleName: '2908 NIKE AUGUSTE',
      providerDriverName: 'NIKE AUGUSTE',
      driverNameMismatch: true,
      pingAgeMinutes: 0,
      pingTimeIso: '2026-05-19T16:00:00Z',
      speedMilesPerHour: 50,
    },
  });
  const text = lines.join('\n');
  assert.match(text, /Driver \(group\): TESFAMARIAM YOSIEF/);
  assert.match(text, /Warning: Samsara still lists/);
});
