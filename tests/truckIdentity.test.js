'use strict';

/**
 * lib/drivers/truckIdentity.js and the owner-aware contest rule — a truck is
 * (fleet, number, OWNER, seat), and the truck's fleet is not the driver's type
 * (owner, 5 November 2026). Pure.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normaliseOwner, ownerFromSuffix, truckFromBoardRow, truckOfProfile, ownersCompatible,
} = require('../lib/drivers/truckIdentity');
const { holderContests, decideUnitSync } = require('../lib/identity/personResolution');
const { holderInRowTruck } = require('../lib/identity/boardResolution');

test('an owner is a name after the number — never a fleet word', () => {
  assert.equal(ownerFromSuffix('ROGER'), 'ROGER');
  assert.equal(ownerFromSuffix('(Polvan)'), 'POLVAN');
  assert.equal(ownerFromSuffix('a ralph'), 'A RALPH');
  for (const word of ['COMP', 'CMP', 'CPM', 'V', 'R', 'L', '', null]) assert.equal(ownerFromSuffix(word), null, String(word));
  assert.equal(normaliseOwner('  (polvan )'), 'POLVAN');
  assert.deepEqual(truckFromBoardRow({ fleetType: 'owner_operator', fleetLabelRaw: 'ERNST' }), { fleetType: 'owner_operator', owner: 'ERNST' });
  assert.deepEqual(truckFromBoardRow({ fleet_type: 'company', fleet_label_raw: 'COMP' }), { fleetType: 'company', owner: null });
});

test("the profile's truck: its own fleet and owner when recorded, else the driver's type", () => {
  assert.deepEqual(
    truckOfProfile({ driver_type: 'company_driver', truck_fleet: 'owner_operator', truck_owner: 'polvan' }),
    { fleetType: 'owner_operator', owner: 'POLVAN' },
    'a hired driver: company driver, owner\'s truck'
  );
  assert.deepEqual(truckOfProfile({ driver_type: 'lease' }), { fleetType: 'lease', owner: null });
  assert.deepEqual(truckOfProfile({ driver_type: null }, 'WENZE UNIT # 9 A (COMPANY DRIVER)'), { fleetType: 'company', owner: null });
  assert.deepEqual(truckOfProfile({ driver_type: 'owner', truck_fleet: 'bogus' }), { fleetType: 'owner_operator', owner: null });
});

test('two known, different owners are two trucks; an unknown owner proves nothing', () => {
  assert.equal(ownersCompatible('ERNST', 'ROGER'), false);
  assert.equal(ownersCompatible('ERNST', null), true);
  assert.equal(ownersCompatible(null, null), true);
  assert.equal(holderContests('owner_operator', 'owner_operator', 'ERNST', 'ROGER'), false);
  assert.equal(holderContests('owner_operator', 'owner_operator', 'ROGER', 'roger'), true);
  assert.equal(holderContests('owner_operator', 'owner_operator', null, 'ROGER'), true);
  assert.equal(holderContests('company', 'owner_operator', null, null), false, 'the fleet rule is unchanged');
  assert.equal(holderContests('unknown', 'owner_operator'), true);
});

test("syncing Roger into 1 is not contested by Ernst's 1", () => {
  const got = decideUnitSync({
    personId: 2, targetUnit: '1', targetFleetType: 'owner_operator', targetOwner: 'ROGER',
    holders: [{ personId: 1, seat: 1, fleetType: 'owner_operator', truckOwner: 'ERNST' }],
  });
  assert.equal(got.action, 'open');
  const blocked = decideUnitSync({
    personId: 2, targetUnit: '1', targetFleetType: 'owner_operator', targetOwner: 'ROGER',
    holders: [{ personId: 1, seat: 1, fleetType: 'owner_operator', truckOwner: null }],
  });
  assert.equal(blocked.action, 'contested', 'an owner not yet recorded is still in the way');
});

test("a board line's truck: the same fleet, and not another owner's", () => {
  const row = { fleetType: 'owner_operator', fleetLabelRaw: 'ROGER' };
  assert.equal(holderInRowTruck(row, { fleetType: 'owner_operator', truckOwner: 'ROGER' }), true);
  assert.equal(holderInRowTruck(row, { fleetType: 'owner_operator', truckOwner: null }), true);
  assert.equal(holderInRowTruck(row, { fleetType: 'owner_operator', truckOwner: 'ERNST' }), false);
  assert.equal(holderInRowTruck({ fleetType: 'company', fleetLabelRaw: 'COMP' }, { fleetType: 'company', truckOwner: null }), true);
});
