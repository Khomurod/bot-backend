'use strict';

/**
 * services/operations/checks/truckFromBoard.js — the board's truck copied onto
 * the profile only for the same person on the same number. Pure.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { runTruckFromBoardChecks, CHECK_KEYS } = require('../services/operations/checks/truckFromBoard');

const group = (id, name, extra = {}) => ({ id, group_name: name, group_type: 'driver', active: true, ...extra });
const board = (truckRaw, truckNorm, fleetType, label, name, extra = {}) => ({
  truck_raw: truckRaw, truck_norm: truckNorm, fleet_type: fleetType, fleet_label_raw: label, driver_name_clean: name, team_members: null, ...extra,
});

function snapshot(over = {}) {
  return {
    groups: [group(60, 'WENZE UNIT # 1 ROGER ALCIDE'), group(61, 'WENZE UNIT # 1 JEROME JOYNER')],
    profiles: [
      { group_id: 60, first_name: 'ROGER', last_name: 'ALCIDE', unit_number: '1', driver_type: 'owner' },
      { group_id: 61, first_name: 'JEROME', last_name: 'JOYNER', unit_number: '1', driver_type: 'owner' },
    ],
    personGroups: [{ group_id: 60, person_id: 6 }, { group_id: 61, person_id: 7 }],
    people: [{ id: 6, display_name: 'ROGER ALCIDE' }, { id: 7, display_name: 'JEROME JOYNER' }],
    boardRows: [
      board('1 ROGER', '1', 'owner_operator', 'ROGER', 'Roger Alcide'),
      board('1 ERNST', '1', 'owner_operator', 'ERNST', 'JEROME JOYNER'),
      board('1 RUDOLPH', '1', 'owner_operator', 'RUDOLPH', 'JOHN ELISEE'),
    ],
    ...over,
  };
}

test('each driver gets the board truck that names HIM on his number: 1 ROGER and 1 ERNST', () => {
  const found = runTruckFromBoardChecks(snapshot());
  assert.deepEqual(found.map((f) => [f.subjectId, f.proposedChange.boardTruck, f.proposedChange.toOwner]), [
    [60, '1 ROGER', 'ROGER'],
    [61, '1 ERNST', 'ERNST'],
  ]);
  assert.equal(found[0].tier, 'auto');
  assert.deepEqual(CHECK_KEYS, ['identity.truck_from_board']);
});

test("a hired driver: the truck's fleet comes from the board, the driver's type is left alone", () => {
  const [f] = runTruckFromBoardChecks(snapshot({
    groups: [group(9, 'WENZE UNIT # 077 DAVID ONOBUN OLUGBENGA ( COMPANY )')],
    profiles: [{ group_id: 9, first_name: 'DAVID ONOBUN', last_name: 'OLUGBENGA', unit_number: '077', driver_type: 'company_driver' }],
    personGroups: [{ group_id: 9, person_id: 1 }],
    people: [{ id: 1, display_name: 'DAVID ONOBUN OLUGBENGA' }],
    boardRows: [board('077 (Polvan)', '077', 'owner_operator', '(POLVAN)', 'OLUGBENGA DAVID ONOBUN')],
  }));
  assert.deepEqual([f.proposedChange.toFleet, f.proposedChange.toOwner], ['owner_operator', 'POLVAN']);
  assert.equal(f.evidence.profileFleet, 'company');
});

test('nothing when the profile already means that truck — a company driver in a company truck', () => {
  assert.deepEqual(runTruckFromBoardChecks(snapshot({
    groups: [group(5, 'WENZE UNIT # 313 ONESIAS FLENCH (COMPANY DRIVER)')],
    profiles: [{ group_id: 5, first_name: 'ONESIAS', last_name: 'FLENCH', unit_number: '313', driver_type: 'company_driver' }],
    personGroups: [{ group_id: 5, person_id: 2 }],
    people: [{ id: 2, display_name: 'ONESIAS FLENCH' }],
    boardRows: [board('313 COMP', '313', 'company', 'COMP', 'FLENCH-BERNECHE ONESIAS')],
  })), []);
  const done = snapshot();
  done.profiles[0] = { ...done.profiles[0], truck_fleet: 'owner_operator', truck_owner: 'ROGER', truck_source: 'board' };
  assert.deepEqual(runTruckFromBoardChecks(done).map((f) => f.subjectId), [61]);
});

test('never on a different number, a looser name, two candidate lines, a hand-set truck or an unread board', () => {
  const s = snapshot();
  // A different number: John's chat says 01, the board says 1 RUDOLPH — a question, not a copy.
  s.groups.push(group(62, 'WENZE UNIT # 01 JOHN / MARK'));
  s.profiles.push({ group_id: 62, first_name: 'JOHN', unit_number: '01', driver_type: 'owner' });
  s.personGroups.push({ group_id: 62, person_id: 8 });
  s.people.push({ id: 8, display_name: 'JOHN / MARK' });
  assert.ok(!runTruckFromBoardChecks(s).some((f) => f.subjectId === 62));

  const twice = snapshot({ boardRows: [...snapshot().boardRows, board('1 ROGER2', '1', 'owner_operator', 'ROGER2', 'ROGER ALCIDE')] });
  assert.ok(!runTruckFromBoardChecks(twice).some((f) => f.subjectId === 60), 'two lines name him: a person decides');

  const manual = snapshot();
  manual.profiles[0] = { ...manual.profiles[0], truck_source: 'manual', truck_fleet: 'owner_operator', truck_owner: 'X' };
  assert.ok(!runTruckFromBoardChecks(manual).some((f) => f.subjectId === 60), 'a person\'s setting is theirs');

  assert.deepEqual(runTruckFromBoardChecks(snapshot({ boardRows: null })), []);
});
