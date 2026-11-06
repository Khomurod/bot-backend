'use strict';

/**
 * lib/fleetCrossCheck/compare.js — the Board ↔ Wenze ↔ Datatruck report. Pure.
 * Keyed on (fleet, number), never the number alone; reports, never decides.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { compareFleet, nameAgreement, driverTypeFromDatatruck, labelKey } = require('../lib/fleetCrossCheck/compare');

const boardRow = (truckRaw, truckNorm, fleetType, driverName, extra = {}) => ({
  truckRaw, truckNorm, fleetType, driverName, ...extra,
});

test('the two 313s are two trucks: each is compared with its own fleet', () => {
  const { rows } = compareFleet({
    board: [
      boardRow('313 COMP', '313', 'company', 'FLENCH-BERNECHE ONESIAS'),
      boardRow('313 FIRUZ', '313', 'owner_operator', 'FIRUZ AZIMOV'),
    ],
    wenze: [
      { unitNumber: '313', fleetType: 'company', displayName: 'ONESIAS FLENCH', driverType: 'company_driver' },
      { unitNumber: '313', fleetType: 'owner_operator', displayName: 'FIRUZ AZIMOV', driverType: 'owner' },
    ],
    datatruckOrders: [
      { label: '313 COMP', drivers: ['Onesias Flench-Berneche'], at: '2026-11-04' },
      { label: '313 FIRUZ', drivers: ['Firuz Azimov', 'Oybek X'], at: '2026-11-03' },
    ],
    datatruckDrivers: [
      { name: 'Onesias Flench-Berneche', driverType: 'company_driver' },
      { name: 'Firuz Azimov', driverType: 'company_owner' },
    ],
  });
  assert.deepEqual(rows.map((r) => r.problems), [[], []]);
  assert.equal(rows[0].wenze.holders[0].name, 'ONESIAS FLENCH');
  assert.equal(rows[0].wenze.name, 'same', 'a double surname and the other order are still the same person');
  assert.deepEqual(rows[1].datatruck.driverTypes, ['company_owner']);
});

test('each kind of disagreement is named', () => {
  const { rows, summary } = compareFleet({
    board: [
      boardRow('016 COMP', '016', 'company', 'NEW DRIVER', { status: 'DISPATCHED' }),
      boardRow('121 V', '121', 'company', 'SHERZAD DIZAII', { status: 'HOME' }),
      boardRow('771 JAFAR', '771', 'owner_operator', 'JAFAR KHALIMOV', { status: 'ENROUTE' }),
      boardRow('101 V', '101', 'company', 'DONIYOR ZIYAEV', { status: 'SHOP' }),
      boardRow('077 (Polvan)', '077', 'owner_operator', 'OLUGBENGA DAVID ONOBUN', { status: 'ENROUTE' }),
    ],
    wenze: [
      { unitNumber: '121', fleetType: 'owner_operator', displayName: 'SHERZAD DIZAII' },
      { unitNumber: '771', fleetType: 'owner_operator', displayName: 'JURABEK SHODMONOV' },
      { unitNumber: '101', fleetType: 'company', displayName: 'DONIYOR ZIYAYEV' },
      { unitNumber: '077', fleetType: 'owner_operator', displayName: 'DAVID ONOBUN OLUGBENGA', driverType: 'owner' },
    ],
    datatruckOrders: [
      { label: '121 V', drivers: ['Sherzad Dizaii'], at: '2026-11-04' },
      { label: '771 JAFAR', drivers: ['Jafar Khalimov'], at: '2026-11-04' },
      { label: '077 (Polvan)', drivers: ['Olugbenga David Onobun'], at: '2026-11-04' },
    ],
    datatruckDrivers: [
      { name: 'Jafar Khalimov', driverType: 'company_owner' },
      { name: 'Olugbenga David Onobun', driverType: 'company_driver' },
    ],
  });
  assert.deepEqual(rows[0].problems, ['not_in_wenze', 'not_in_datatruck'], 'working, and no load');
  assert.deepEqual(rows[1].problems, ['fleet_differs_wenze']);
  assert.deepEqual(rows[1].wenze.otherFleets, [{ fleetType: 'owner_operator', truckOwner: null, name: 'SHERZAD DIZAII' }]);
  assert.deepEqual(rows[2].problems, ['name_differs_wenze']);
  assert.deepEqual(rows[3].problems, ['name_close_wenze'], 'in the shop: no load this week is expected');
  // A driver hired by an owner: the truck is an owner's, the driver a company driver.
  assert.deepEqual(rows[4].problems, ['driver_type_differs_datatruck']);
  assert.deepEqual(rows[4].datatruck.driverTypeConflict, {
    wenze: 'owner', datatruck: 'company_driver', datatruckDriverType: 'company_driver', name: 'DAVID ONOBUN OLUGBENGA', datatruckName: 'Olugbenga David Onobun', groupId: null,
  });
  assert.equal(summary.allAgree, 0);
  assert.equal(summary.notInWenze, 1);
  assert.equal(summary.driverTypeDiffersDatatruck, 1);
});

test("a name after the number is the truck's owner: 1 ERNST, 1 ROGER and 1 RUDOLPH are three trucks", () => {
  const { rows } = compareFleet({
    board: [
      boardRow('1 ERNST', '1', 'owner_operator', 'JEROME JOYNER'),
      boardRow('1 ROGER', '1', 'owner_operator', 'ROGER ALCIDE'),
      boardRow('1 RUDOLPH', '1', 'owner_operator', 'JOHN ELISEE'),
      boardRow('003 CPM', '003', 'company', 'TERRELL DALTON'),
    ],
    wenze: [],
    datatruckOrders: [
      { label: '1 ERNST', drivers: ['Jerome Joyner'], at: '2026-11-04' },
      { label: '1 RUDOLPH', drivers: ['John Elisee'], at: '2026-11-03' },
      { label: '003 CMP', drivers: ['Terrell Dalton'], at: '2026-11-03' },
    ],
  });
  assert.deepEqual(rows[0].datatruck.drivers, ['Jerome Joyner']);
  assert.equal(rows[1].datatruck.label, null, "Roger's truck has no load — not Ernst's");
  assert.deepEqual(rows[2].datatruck.drivers, ['John Elisee']);
  assert.deepEqual(rows[3].datatruck.drivers, ['Terrell Dalton'], 'CPM is CMP');
  assert.equal(labelKey('077 (Polvan)'), '077|POLVAN');
});

test('the newest load decides who drove a truck in Datatruck', () => {
  const { rows } = compareFleet({
    board: [boardRow('320 COMP', '320', 'company', 'IRA STRUM')],
    wenze: [{ unitNumber: '320', fleetType: 'company', displayName: 'IRA STRUM' }],
    datatruckOrders: [
      { label: '320 COMP', drivers: ['Alimardon Khakimov'], at: '2026-10-30T10:00:00Z' },
      { label: '320 COMP', drivers: ['Ira Strum'], at: '2026-11-04T10:00:00Z' },
    ],
  });
  assert.deepEqual(rows[0].datatruck.drivers, ['Ira Strum']);
  assert.deepEqual(rows[0].problems, []);
});

test('a team on the board agrees when either driver is the one Wenze holds', () => {
  const { rows } = compareFleet({
    board: [boardRow('324 COMP', '324', 'company', 'ANTHONY COLLINS / JAMES BRISCOE', { teamMembers: ['ANTHONY COLLINS', 'JAMES BRISCOE'] })],
    wenze: [{ unitNumber: '324', fleetType: 'company', displayName: 'JAMES BRISCOE' }],
    datatruckOrders: null,
  });
  assert.equal(rows[0].wenze.name, 'same');
  assert.deepEqual(rows[0].problems, []);
});

test('DATATRUCK NOT READ is said, never read as agreement', () => {
  const { rows, summary } = compareFleet({
    board: [boardRow('016 COMP', '016', 'company', 'NEW DRIVER')],
    wenze: [],
    datatruckOrders: null,
  });
  assert.deepEqual(rows[0].datatruck, { read: false });
  assert.deepEqual(rows[0].problems, ['not_in_wenze'], 'no Datatruck verdict either way');
  assert.equal(summary.datatruckRead, false);
});

test('names and Datatruck types', () => {
  assert.equal(nameAgreement('LATRAVIA MC LEAN', 'MCLEAN LATRAVIA'), 'close');
  assert.equal(nameAgreement('TORREY SWATT', 'TORREY SWATT'), 'same');
  assert.equal(nameAgreement('TASHAYLA BROOKS', 'IRA MATTHEW'), 'different');
  assert.equal(nameAgreement(null, 'X Y'), null);
  assert.equal(driverTypeFromDatatruck('company_driver'), 'company_driver');
  assert.equal(driverTypeFromDatatruck('company_owner'), 'owner');
  assert.equal(driverTypeFromDatatruck('Owner_Operator'), 'owner');
  assert.equal(driverTypeFromDatatruck('something_new'), null, 'an unknown word is shown, never guessed');
});

test('1 ERNST and 1 ROGER: each board truck is compared with its own owner\'s truck in Wenze', () => {
  const { rows } = compareFleet({
    board: [
      boardRow('1 ERNST', '1', 'owner_operator', 'JEROME JOYNER', { fleetLabelRaw: 'ERNST' }),
      boardRow('1 ROGER', '1', 'owner_operator', 'ROGER ALCIDE', { fleetLabelRaw: 'ROGER' }),
      boardRow('1 RUDOLPH', '1', 'owner_operator', 'JOHN ELISEE', { fleetLabelRaw: 'RUDOLPH' }),
    ],
    wenze: [
      { unitNumber: '1', fleetType: 'owner_operator', truckOwner: 'ERNST', displayName: 'JEROME JOYNER' },
      { unitNumber: '1', fleetType: 'owner_operator', truckOwner: 'ROGER', displayName: 'ROGER ALCIDE' },
      // Owner not recorded yet: it rules nobody out.
      { unitNumber: '1', fleetType: 'owner_operator', truckOwner: null, displayName: 'JOHN ELISEE' },
    ],
  });
  assert.deepEqual(rows[0].wenze.holders.map((h) => h.name), ['JEROME JOYNER', 'JOHN ELISEE']);
  assert.deepEqual(rows[1].wenze.holders.map((h) => h.name), ['ROGER ALCIDE', 'JOHN ELISEE']);
  assert.deepEqual(rows[1].wenze.otherFleets, [{ fleetType: 'owner_operator', truckOwner: 'ERNST', name: 'JEROME JOYNER' }]);
  assert.deepEqual(rows.map((r) => r.problems), [[], [], []], 'each line finds its own driver');

  const only = compareFleet({
    board: [boardRow('1 ROGER', '1', 'owner_operator', 'ROGER ALCIDE', { fleetLabelRaw: 'ROGER' })],
    wenze: [{ unitNumber: '1', fleetType: 'owner_operator', truckOwner: 'ERNST', displayName: 'JEROME JOYNER' }],
  }).rows[0];
  assert.deepEqual(only.problems, ['fleet_differs_wenze'], 'another owner\'s 1 is another truck, not a different driver in this one');
});
