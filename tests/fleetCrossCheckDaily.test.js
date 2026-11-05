'use strict';

/**
 * services/fleetCrossCheck/daily.js and checks/fleetCrossCheck.js — Datatruck
 * read once a day into memory, and a sweep check that refuses to run without
 * that read (so its open questions are never resolved by a missing source).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createDailyRead, STALE_AFTER_MS } = require('../services/fleetCrossCheck/daily');
const { runFleetCrossCheckChecks, wenzeFromSnapshot, CHECK_KEYS } = require('../services/operations/checks/fleetCrossCheck');

function fakeDatatruck({ configured = true, fail = false } = {}) {
  const calls = { drivers: 0, orders: 0 };
  return {
    calls,
    isConfigured: () => configured,
    async fetchAllDrivers() {
      calls.drivers += 1;
      if (fail) { const e = new Error('nope'); e.status = 503; throw e; }
      return [{ account: { first_name: 'Antoine', last_name: 'Campbell' }, driver_type: 'company_driver' }];
    },
    async fetchOrdersByPickupWindow() {
      calls.orders += 1;
      return [{ trip: { truck__unit_number: '888 CMP', driver__full_name: 'Antoine Campbell' }, pickup_time: '2026-11-04T10:00:00Z' }];
    },
  };
}

test('nothing until a read has succeeded; then the read; a failed read keeps the last good one', async () => {
  let now = Date.parse('2026-11-05T12:00:00Z');
  const dt = fakeDatatruck();
  const daily = createDailyRead({ datatruck: dt, now: () => now });
  assert.equal(daily.latest(), null);
  assert.equal(await daily.refresh(), true);
  assert.deepEqual(daily.latest().drivers, [{ name: 'Antoine Campbell', driverType: 'company_driver' }]);
  assert.equal(daily.latest().orders[0].label, '888 CMP');

  const failing = createDailyRead({ datatruck: fakeDatatruck({ fail: true }), now: () => now });
  assert.equal(await failing.refresh(), false);
  assert.equal(failing.latest(), null);
  assert.match(failing.status().lastFailure.reason, /HTTP 503/);
  assert.doesNotMatch(failing.status().lastFailure.reason, /https?:\/\//i, 'a status code, never a URL');

  now += STALE_AFTER_MS + 1;
  assert.equal(daily.latest(), null, 'two days old is no longer a vote');
  assert.equal(daily.status().stale, true);
});

test('one read at a time: two callers, one request', async () => {
  const dt = fakeDatatruck();
  const daily = createDailyRead({ datatruck: dt, now: () => Date.now() });
  await Promise.all([daily.refresh(), daily.refresh()]);
  assert.deepEqual(dt.calls, { drivers: 1, orders: 1 });
});

test('not connected is said, and nothing is read', async () => {
  const dt = fakeDatatruck({ configured: false });
  const daily = createDailyRead({ datatruck: dt, now: () => Date.now() });
  assert.equal(await daily.refresh(), false);
  assert.deepEqual(dt.calls, { drivers: 0, orders: 0 });
  assert.match(daily.status().lastFailure.reason, /not connected/);
});

const SNAPSHOT = {
  groups: [{ id: 964037, group_name: 'WENZE UNIT # 888 ANTOINE CAMPBELL (COMPANY DRIVER)', group_type: 'driver', active: true }],
  profiles: [{ group_id: 964037, unit_number: '888', driver_type: 'company_driver' }],
  personGroups: [{ person_id: 151, group_id: 964037 }],
  people: [{ id: 151, display_name: 'ANTOINE CAMPBELL' }],
  units: [{ person_id: 151, unit_number: '888', fleet_type: 'company', truck_owner: null, seat: 1 }],
  boardRows: [{
    truck_raw: '888', truck_norm: '888', fleet_type: 'owner_operator', fleet_label_raw: null, driver_name_clean: 'ANTOINE CAMPBELL', team_members: null, status: 'ENROUTE',
  }],
};

test('the sweep check refuses to run without the day\'s Datatruck read, and without the board', () => {
  assert.throws(() => runFleetCrossCheckChecks({ ...SNAPSHOT, datatruckFleet: null }), /not been read today/);
  assert.throws(() => runFleetCrossCheckChecks({ ...SNAPSHOT, boardRows: null, datatruckFleet: { orders: [], drivers: [] } }), /Board could not be read/);
});

test('with the read, it compares the live board and Wenze against it', () => {
  const found = runFleetCrossCheckChecks({
    ...SNAPSHOT,
    datatruckFleet: {
      readAt: '2026-11-05T12:00:00Z',
      orders: [{ label: '888 CMP', drivers: ['Antoine Campbell'], at: '2026-11-04' }],
      drivers: [{ name: 'Antoine Campbell', driverType: 'company_driver' }],
    },
  });
  assert.deepEqual(found.map((f) => f.checkKey), ['fleet.board_suffix_missing']);
  assert.equal(found[0].evidence.datatruckReadAt, '2026-11-05T12:00:00Z');
  assert.ok(CHECK_KEYS.every((k) => k.startsWith('fleet.')));
});

test('Wenze from the snapshot: each truck with its person and that person\'s active chat', () => {
  assert.deepEqual(wenzeFromSnapshot(SNAPSHOT), [{
    unitNumber: '888', fleetType: 'company', truckOwner: null, displayName: 'ANTOINE CAMPBELL', groupId: 964037, groupName: 'WENZE UNIT # 888 ANTOINE CAMPBELL (COMPANY DRIVER)', driverType: 'company_driver',
  }]);
});
