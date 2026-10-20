'use strict';

/**
 * services/operations/checks/identityLayer.js — a truck recorded to a driver
 * who has LEFT is a handover the sweep may make; one recorded to a driver who
 * still works is a dispute for a person. Pure. The owner's decision of 20
 * October 2026 (decision B2).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const layer = require('../services/operations/checks/identityLayer');

const group = (id, name, extra = {}) => ({ id, group_name: name, group_type: 'driver', active: true, ...extra });
const profile = (groupId, unit) => ({ group_id: groupId, unit_number: unit, status: 'active' });

/** Vernet left (his chat is inactive); Prince's chat now names truck 013. */
function fleet(over = {}) {
  return {
    groups: [
      group(303269, 'WENZE UNIT # 013 VERNET FELICIEN (COMPANY DRIVER ) INACTIVE', { active: false }),
      group(866389, 'WENZE UNIT # 013 PRINCE BURTON / OTIS CONWAY (COMPANY DRIVER)'),
    ],
    profiles: [profile(303269, '013'), profile(866389, '013')],
    personGroups: [{ person_id: 29, group_id: 303269 }, { person_id: 123, group_id: 866389 }],
    units: [{ person_id: 29, unit_number: '013', fleet_type: 'company', seat: 1 }],
    people: [{ id: 29, display_name: 'VERNET FELICIEN' }, { id: 123, display_name: 'PRINCE BURTON' }],
    ...over,
  };
}

test('THE HOLDER HAS LEFT: an auto handover, naming the truck and who it passes to', () => {
  const [found, ...rest] = layer.checkUnitContested(fleet());
  assert.equal(rest.length, 0);
  assert.equal(found.checkKey, 'identity.unit_handover');
  assert.equal(found.tier, 'auto');
  assert.equal(found.subjectId, 866389);
  assert.deepEqual(found.proposedChange, {
    table: 'driver_units', personId: 123, groupId: 866389, unitNumber: '013', holderPersonIds: [29],
  });
  assert.match(found.title, /unit 013 is still recorded to VERNET FELICIEN, who has no active chat/);
});

test('THE HOLDER STILL DRIVES: a dispute for a person, never a handover', () => {
  const working = fleet({
    groups: [...fleet().groups, group(5, 'WENZE UNIT # 044 VERNET FELICIEN')],
    personGroups: [...fleet().personGroups, { person_id: 29, group_id: 5 }],
  });
  const [found] = layer.checkUnitContested(working);
  assert.equal(found.checkKey, 'identity.unit_contested');
  assert.equal(found.tier, 'warning');
  assert.equal(found.proposedChange, undefined);
});

test('a claimant on two active chats is not handed anything — which truck is its own question', () => {
  const twoChats = fleet({
    groups: [...fleet().groups, group(6, 'WENZE UNIT # 099 PRINCE BURTON')],
    personGroups: [...fleet().personGroups, { person_id: 123, group_id: 6 }],
  });
  const keys = layer.checkUnitContested(twoChats).map((f) => f.checkKey);
  assert.ok(!keys.includes('identity.unit_handover'), keys.join());
});

test('a holder in another fleet is in another truck: nothing to hand over or dispute', () => {
  const ownerTruck = fleet({ units: [{ person_id: 29, unit_number: '013', fleet_type: 'owner_operator', seat: 1 }] });
  assert.deepEqual(layer.checkUnitContested(ownerTruck), []);
});

test('the handover key is declared, so the sweep closes it once the truck has moved', () => {
  assert.ok(layer.CHECK_KEYS.includes('identity.unit_handover'));
});
