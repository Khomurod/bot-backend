'use strict';

/**
 * services/operations/checks/identityLayer.js — the right truck recorded under
 * the wrong fleet. The profile is the record; the truck row follows it (the
 * owner's decision of 5 November 2026). Pure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const layer = require('../services/operations/checks/identityLayer');

const group = (id, name, extra = {}) => ({ id, group_name: name, group_type: 'driver', active: true, ...extra });
const profile = (groupId, unit, driverType) => ({ group_id: groupId, unit_number: unit, driver_type: driverType, status: 'active' });

/** 121: the profile says Company driver, the truck row still says Owner-Operator. */
function fleet(over = {}) {
  return {
    groups: [group(10, 'WENZE UNIT # 121 SHERZAD DIZAII ( COMPANY )')],
    profiles: [profile(10, '121', 'company_driver')],
    personGroups: [{ person_id: 7, group_id: 10 }],
    units: [{ person_id: 7, unit_number: '121', fleet_type: 'owner_operator', seat: 1 }],
    people: [{ id: 7, display_name: 'SHERZAD DIZAII' }],
    ...over,
  };
}

test("a truck row behind the profile's fleet: an auto finding that names both fleets", () => {
  const [found, ...rest] = layer.checkUnitFleetBehindProfile(fleet());
  assert.equal(rest.length, 0);
  assert.equal(found.checkKey, 'identity.unit_fleet_behind_profile');
  assert.equal(found.tier, 'auto');
  assert.deepEqual(found.proposedChange, {
    table: 'driver_units', personId: 7, groupId: 10, unitNumber: '121', from: 'owner_operator', to: 'company', fromOwner: null, toOwner: null,
  });
  assert.ok(layer.CHECK_KEYS.includes('identity.unit_fleet_behind_profile'));
  assert.ok(layer.runIdentityLayerChecks(fleet()).some((f) => f.checkKey === 'identity.unit_fleet_behind_profile'));
});

test('the profile decides: lease on the profile, company on the row → lease', () => {
  const [found] = layer.checkUnitFleetBehindProfile(fleet({
    groups: [group(10, 'WENZE UNIT # 311 ABDINASIR / IBRAHIM (LEASE DRIVERS)')],
    profiles: [profile(10, '311', 'lease')],
    units: [{ person_id: 7, unit_number: '311', fleet_type: 'company', seat: 1 }],
  }));
  assert.equal(found.proposedChange.to, 'lease');
  assert.equal(found.proposedChange.from, 'company');
});

test('nothing when the fleets already agree, or the profile cannot say', () => {
  assert.deepEqual(layer.checkUnitFleetBehindProfile(fleet({
    units: [{ person_id: 7, unit_number: '121', fleet_type: 'company', seat: 1 }],
  })), []);
  assert.deepEqual(layer.checkUnitFleetBehindProfile(fleet({
    groups: [group(10, 'WENZE UNIT # 121 SHERZAD DIZAII')],
    profiles: [profile(10, '121', null)],
  })), [], 'no driver type and no label in the title: nothing to follow');
});

test('nothing when the TRUCK is behind — that is the stale-unit check, not this one', () => {
  assert.deepEqual(layer.checkUnitFleetBehindProfile(fleet({
    units: [{ person_id: 7, unit_number: '120', fleet_type: 'owner_operator', seat: 1 }],
  })), []);
});

test("nothing when somebody else holds that truck in the profile's fleet — a person decides", () => {
  assert.deepEqual(layer.checkUnitFleetBehindProfile(fleet({
    units: [
      { person_id: 7, unit_number: '121', fleet_type: 'owner_operator', seat: 1 },
      { person_id: 8, unit_number: '121', fleet_type: 'company', seat: 1 },
    ],
  })), []);
});

test('nothing for a person on two active chats, or a chat that is not active', () => {
  assert.deepEqual(layer.checkUnitFleetBehindProfile(fleet({
    groups: [...fleet().groups, group(11, 'WENZE UNIT # 999 SHERZAD DIZAII')],
    personGroups: [...fleet().personGroups, { person_id: 7, group_id: 11 }],
  })), []);
  assert.deepEqual(layer.checkUnitFleetBehindProfile(fleet({
    groups: [group(10, 'WENZE UNIT # 121 SHERZAD DIZAII ( COMPANY ) INACTIVE', { active: false })],
  })), []);
});

test("the TRUCK the profile names wins over the driver's type: a hired driver in an owner's truck", () => {
  // 077 (Polvan): the driver is a company driver, the truck is Polvan's (owner, 5 November 2026).
  const [found] = layer.checkUnitFleetBehindProfile(fleet({
    groups: [group(10, 'WENZE UNIT # 077 DAVID ONOBUN OLUGBENGA ( COMPANY )')],
    profiles: [{ ...profile(10, '077', 'company_driver'), truck_fleet: 'owner_operator', truck_owner: 'POLVAN' }],
    units: [{ person_id: 7, unit_number: '077', fleet_type: 'company', seat: 1, truck_owner: null }],
  }));
  assert.equal(found.proposedChange.to, 'owner_operator');
  assert.equal(found.proposedChange.toOwner, 'POLVAN');
  assert.match(found.title, /owner POLVAN/);
});

test('an owner the record lacks is brought to the profile; one it already has is left alone', () => {
  const base = {
    groups: [group(10, 'WENZE UNIT # 1 ROGER ALCIDE')],
    profiles: [{ ...profile(10, '1', 'owner'), truck_fleet: 'owner_operator', truck_owner: 'ROGER' }],
  };
  const [found] = layer.checkUnitFleetBehindProfile(fleet({
    ...base, units: [{ person_id: 7, unit_number: '1', fleet_type: 'owner_operator', seat: 1, truck_owner: null }],
  }));
  assert.equal(found.proposedChange.toOwner, 'ROGER');
  assert.deepEqual(layer.checkUnitFleetBehindProfile(fleet({
    ...base, units: [{ person_id: 7, unit_number: '1', fleet_type: 'owner_operator', seat: 1, truck_owner: 'ROGER' }],
  })), []);
});

test("another owner's truck with the same number is not in the way: 1 ERNST does not block 1 ROGER", () => {
  const [found] = layer.checkUnitFleetBehindProfile(fleet({
    groups: [group(10, 'WENZE UNIT # 1 ROGER ALCIDE')],
    profiles: [{ ...profile(10, '1', 'owner'), truck_fleet: 'owner_operator', truck_owner: 'ROGER' }],
    units: [
      { person_id: 7, unit_number: '1', fleet_type: 'owner_operator', seat: 1, truck_owner: null },
      { person_id: 8, unit_number: '1', fleet_type: 'owner_operator', seat: 1, truck_owner: 'ERNST' },
    ],
  }));
  assert.ok(found, 'Ernst holds his own 1, not Roger\'s');
});
