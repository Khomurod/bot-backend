'use strict';

/**
 * lib/fleetCrossCheck/findings.js — the daily Board ↔ Wenze ↔ Datatruck check.
 * Pure. Every finding needs a second source on the side it would change;
 * nothing here is ever applied without a person.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { compareFleet } = require('../lib/fleetCrossCheck/compare');
const { crossCheckFindings, boardDriverType, CHECK_KEYS } = require('../lib/fleetCrossCheck/findings');

const board = (truckRaw, truckNorm, fleetType, driverName, extra = {}) => ({
  truckRaw, truckNorm, fleetType, driverName, status: 'ENROUTE', ...extra,
});

function run({ boardRows, wenze = [], orders = [], drivers = [] }) {
  const { rows } = compareFleet({
    board: boardRows, wenze, datatruckOrders: orders, datatruckDrivers: drivers,
  });
  return crossCheckFindings({ rows, wenze, orders });
}

test('the board and Datatruck have a driver Wenze has nobody for: a notice that names where Wenze has him', () => {
  const [f, ...rest] = run({
    boardRows: [board('1 RUDOLPH', '1', 'owner_operator', 'JOHN ELISEE', { fleetLabelRaw: 'RUDOLPH' })],
    wenze: [{ unitNumber: '01', fleetType: 'owner_operator', displayName: 'JOHN ELISEE', groupId: 347484, groupName: 'WENZE UNIT # 01 JOHN / MARK' }],
    orders: [{ label: '1 RUDOLPH', drivers: ['John Elisee'], at: '2026-11-04' }],
  });
  assert.equal(rest.length, 0);
  assert.equal(f.checkKey, 'fleet.driver_not_in_wenze');
  assert.equal(f.tier, 'warning', 'only a person can add a chat or a unit');
  assert.equal(f.subjectType, 'board_truck');
  assert.deepEqual(f.evidence.wenzeElsewhere, [{ unitNumber: '01', groupName: 'WENZE UNIT # 01 JOHN / MARK' }]);
  assert.match(f.title, /Wenze has this driver on 01/);
});

test('one source is not two: the board alone, or Datatruck naming somebody else, files nothing', () => {
  assert.deepEqual(run({
    boardRows: [board('016 COMP', '016', 'company', 'ZAKY GEBREYESUS', { fleetLabelRaw: 'COMP' })],
    orders: [],
  }), []);
  assert.deepEqual(run({
    boardRows: [board('016 COMP', '016', 'company', 'ZAKY GEBREYESUS', { fleetLabelRaw: 'COMP' })],
    orders: [{ label: '016 COMP', drivers: ['Somebody Else'], at: '2026-11-04' }],
  }), []);
});

test('888 lost its CMP on the board; Datatruck still writes 888 CMP for the same driver: a notice for the board', () => {
  const found = run({
    boardRows: [board('888', '888', 'owner_operator', 'ANTOINE CAMPBELL', { fleetLabelRaw: null })],
    wenze: [{ unitNumber: '888', fleetType: 'company', displayName: 'ANTOINE CAMPBELL', groupId: 964037, driverType: 'company_driver' }],
    orders: [{ label: '888 CMP', drivers: ['Antoine Campbell'], at: '2026-11-04' }],
  });
  const f = found.find((x) => x.checkKey === 'fleet.board_suffix_missing');
  assert.ok(f, JSON.stringify(found.map((x) => x.checkKey)));
  assert.equal(f.tier, 'warning');
  assert.equal(f.evidence.datatruckLabel, '888 CMP');
  assert.equal(f.evidence.datatruckFleet, 'company');
  // A bare number whose Datatruck label is also bare, or names an owner, is no lost suffix.
  assert.deepEqual(run({
    boardRows: [board('888', '888', 'owner_operator', 'ANTOINE CAMPBELL')],
    orders: [{ label: '888', drivers: ['Antoine Campbell'], at: '2026-11-04' }],
  }).filter((x) => x.checkKey === 'fleet.board_suffix_missing'), []);
});

test('Wenze calls the hired driver an owner; Datatruck and the board say company driver: a question with a Yes', () => {
  const [f] = run({
    boardRows: [board('077 (Polvan)', '077', 'owner_operator', 'OLUGBENGA DAVID ONOBUN', { fleetLabelRaw: '(POLVAN)' })],
    wenze: [{
      unitNumber: '077', fleetType: 'owner_operator', truckOwner: 'POLVAN', displayName: 'DAVID ONOBUN OLUGBENGA', groupId: 9, groupName: 'WENZE UNIT # 077 DAVID', driverType: 'owner',
    }],
    orders: [{ label: '077 (Polvan)', drivers: ['Olugbenga David Onobun'], at: '2026-11-04' }],
    drivers: [{ name: 'Olugbenga David Onobun', driverType: 'company_driver' }],
  });
  assert.equal(f.checkKey, 'fleet.driver_type_differs_datatruck');
  assert.equal(f.tier, 'approval', 'never applied without a person');
  assert.equal(f.subjectId, 9);
  assert.deepEqual(f.proposedChange, {
    table: 'driver_profiles', groupId: 9, from: 'owner', to: 'company_driver',
  });
  assert.equal(f.evidence.boardType, 'company_driver');
  assert.equal(f.confidence, 80, 'two sources against one');
});

test('the board on Wenze\'s side makes Datatruck the odd one out: not Wenze\'s to change', () => {
  const found = run({
    boardRows: [board('771 JAFAR', '771', 'owner_operator', 'JAFAR KHALIMOV', { fleetLabelRaw: 'JAFAR' })],
    wenze: [{ unitNumber: '771', fleetType: 'owner_operator', truckOwner: 'JAFAR', displayName: 'JAFAR KHALIMOV', groupId: 25, driverType: 'owner' }],
    orders: [{ label: '771 JAFAR', drivers: ['Jafar Khalimov'], at: '2026-11-04' }],
    drivers: [{ name: 'Jafar Khalimov', driverType: 'company_driver' }],
  });
  assert.deepEqual(found, []);
});

test('what the board label says about the DRIVER', () => {
  assert.equal(boardDriverType('016 COMP', ['X']), 'company_driver');
  assert.equal(boardDriverType('888 CMP', ['X']), 'company_driver');
  assert.equal(boardDriverType('121 V', ['X']), 'company_driver');
  assert.equal(boardDriverType('266116 R', ['X']), 'lease');
  assert.equal(boardDriverType('2614 L', ['X']), 'owner');
  assert.equal(boardDriverType('5406', ['RAY RANSOM']), 'owner', 'a bare number: the owner at his own wheel');
  assert.equal(boardDriverType('771 JAFAR', ['JAFAR KHALIMOV']), 'owner', 'his own name on his own truck');
  assert.equal(boardDriverType('077 (Polvan)', ['OLUGBENGA DAVID ONOBUN']), 'company_driver', 'another owner\'s name: hired');
  assert.deepEqual([...CHECK_KEYS], ['fleet.driver_not_in_wenze', 'fleet.board_suffix_missing', 'fleet.driver_type_differs_datatruck']);
});
