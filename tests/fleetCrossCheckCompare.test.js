'use strict';

/**
 * lib/fleetCrossCheck/compare.js — the Board ↔ Wenze ↔ Datatruck report. Pure.
 * Keyed on (fleet, number), never the number alone; reports, never decides.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { compareFleet, nameAgreement, fleetFromDatatruckType } = require('../lib/fleetCrossCheck/compare');

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
      { unitNumber: '313', fleetType: 'company', displayName: 'ONESIAS FLENCH' },
      { unitNumber: '313', fleetType: 'owner_operator', displayName: 'FIRUZ AZIMOV' },
    ],
    datatruckOrders: [
      { label: '313 COMP', drivers: ['Onesias Flench-Berneche'], at: '2026-11-04' },
      { label: '313 FIRUZ', drivers: ['Firuz Azimov', 'Oybek X'], at: '2026-11-03' },
    ],
    datatruckDrivers: [
      { name: 'Onesias Flench-Berneche', driverType: 'company_driver' },
      { name: 'Firuz Azimov', driverType: 'owner_operator' },
    ],
  });
  assert.deepEqual(rows.map((r) => r.problems), [[], []]);
  assert.equal(rows[0].wenze.holders[0].name, 'ONESIAS FLENCH');
  assert.equal(rows[0].wenze.name, 'same', 'a double surname and the other order are still the same person');
  assert.equal(rows[1].datatruck.fleetType, 'owner_operator');
});

test('each kind of disagreement is named', () => {
  const { rows, summary } = compareFleet({
    board: [
      boardRow('016 COMP', '016', 'company', 'NEW DRIVER'),
      boardRow('121 V', '121', 'company', 'SHERZAD DIZAII'),
      boardRow('771 JAFAR', '771', 'owner_operator', 'JAFAR KHALIMOV'),
      boardRow('101 V', '101', 'company', 'DONIYOR ZIYAEV'),
    ],
    wenze: [
      { unitNumber: '121', fleetType: 'owner_operator', displayName: 'SHERZAD DIZAII' },
      { unitNumber: '771', fleetType: 'owner_operator', displayName: 'JURABEK SHODMONOV' },
      { unitNumber: '101', fleetType: 'company', displayName: 'DONIYOR ZIYAYEV' },
    ],
    datatruckOrders: [
      { label: '121 V', drivers: ['Sherzad Dizaii'], at: '2026-11-04' },
      { label: '771 JAFAR', drivers: ['Jafar Khalimov'], at: '2026-11-04' },
    ],
    datatruckDrivers: [{ name: 'Jafar Khalimov', driverType: 'company_driver' }],
  });
  assert.deepEqual(rows[0].problems, ['not_in_wenze', 'not_in_datatruck']);
  assert.deepEqual(rows[1].problems, ['fleet_differs_wenze']);
  assert.deepEqual(rows[1].wenze.otherFleets, [{ fleetType: 'owner_operator', name: 'SHERZAD DIZAII' }]);
  assert.deepEqual(rows[2].problems, ['name_differs_wenze', 'fleet_differs_datatruck']);
  assert.deepEqual(rows[3].problems, ['name_close_wenze', 'not_in_datatruck'], 'one letter apart is close, not different');
  assert.equal(summary.allAgree, 0);
  assert.equal(summary.notInWenze, 1);
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
  assert.equal(fleetFromDatatruckType('company_driver'), 'company');
  assert.equal(fleetFromDatatruckType('Owner_Operator'), 'owner_operator');
  assert.equal(fleetFromDatatruckType('something_new'), null, 'an unknown word is shown, never guessed');
});
