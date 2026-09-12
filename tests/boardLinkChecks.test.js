'use strict';

/**
 * Turning a Board row into a finding — and which tier it lands in.
 *
 * The tier is the whole safety story. Only `board.person_link` is `auto`, and
 * only because two independent facts agreed; everything else is a question with
 * `proposedChange: null`, because a disagreement between two systems is not
 * evidence about which one is right.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { runBoardLinkChecks, CHECK_KEYS } = require('../services/operations/checks/boardLink');
const { CHECKS } = require('../lib/identity/boardResolution');

function row(over = {}) {
  return {
    rowKey: '001|JOHN SMITH', present: true, cleanName: 'JOHN SMITH',
    fleetType: 'company', truckNorm: '001', truckDigits: '1',
    isTeam: false, teamMembers: [], personId: null, ...over,
  };
}

function layer({ people = [], units = [] } = {}) {
  return { people, units };
}

const JOHN = { id: 5, display_name: 'JOHN SMITH', merged_into_person_id: null };
const MARIA = { id: 6, display_name: 'MARIA GARCIA', merged_into_person_id: null };

test('the truck and the name agreeing is the ONLY auto-tier finding', () => {
  const [found] = runBoardLinkChecks({
    boardRows: [row()],
    layer: layer({
      people: [JOHN],
      units: [{ person_id: 5, unit_number: '001', fleet_type: 'company', seat: 1 }],
    }),
  });
  assert.equal(found.checkKey, 'board.person_link');
  assert.equal(found.tier, 'auto');
  assert.deepEqual(found.proposedChange, { rowKey: '001|JOHN SMITH', personId: 5, linkSource: 'board' });
});

test('a name-only match is approval tier — a person decides', () => {
  const [found] = runBoardLinkChecks({
    boardRows: [row()], layer: layer({ people: [JOHN], units: [] }),
  });
  assert.equal(found.checkKey, 'board.person_link_suggested');
  assert.equal(found.tier, 'approval');
  assert.equal(found.proposedChange.personId, 5);
});

test('EVERY DISAGREEMENT PROPOSES NOTHING', () => {
  const cases = [
    // The board says this truck; we have somebody else in it.
    {
      boardRows: [row()],
      layer: layer({
        people: [MARIA], units: [{ person_id: 6, unit_number: '001', fleet_type: 'company', seat: 1 }],
      }),
      expect: CHECKS.CONFLICT,
    },
    // Two people recorded in one truck.
    {
      boardRows: [row()],
      layer: layer({
        people: [JOHN, MARIA],
        units: [
          { person_id: 5, unit_number: '001', fleet_type: 'company', seat: 1 },
          { person_id: 6, unit_number: '001', fleet_type: 'company', seat: 2 },
        ],
      }),
      expect: CHECKS.AMBIGUOUS,
    },
    // Nobody at all.
    { boardRows: [row()], layer: layer({ people: [MARIA], units: [] }), expect: CHECKS.UNMATCHED },
  ];
  for (const c of cases) {
    const [found] = runBoardLinkChecks(c);
    assert.equal(found.checkKey, c.expect);
    assert.equal(found.proposedChange, null, `${c.expect} must propose nothing`);
    assert.equal(found.tier, 'warning');
  }
});

test('an unmatched row is INFO — a board ahead of its records is ordinary', () => {
  const [found] = runBoardLinkChecks({ boardRows: [row()], layer: layer() });
  assert.equal(found.severity, 'info');
});

test('A DIGITS-ONLY TRUCK MATCH IS FOUND AND THEN REFUSED', () => {
  // Found, because a match nobody saw gets reported as "nobody is in this
  // truck" — a different and wrong answer. Refused, because 001 and 1 and 001A
  // reduce to the same digits and are three trucks.
  const [found] = runBoardLinkChecks({
    boardRows: [row({ truckNorm: '001A', truckDigits: '1' })],
    layer: layer({
      people: [JOHN], units: [{ person_id: 5, unit_number: '1', fleet_type: 'company', seat: 1 }],
    }),
  });
  assert.equal(found.checkKey, CHECKS.AMBIGUOUS);
  assert.equal(found.proposedChange, null);
});

test('a different fleet on the same number is a different truck', () => {
  const [found] = runBoardLinkChecks({
    boardRows: [row()],
    layer: layer({
      people: [JOHN, MARIA],
      units: [{ person_id: 6, unit_number: '001', fleet_type: 'lease', seat: 1 }],
    }),
  });
  // The lease holder says nothing about a company row, so the name decides.
  assert.equal(found.checkKey, 'board.person_link_suggested');
  assert.equal(found.evidence.driver, 'JOHN SMITH');
});

test('an already-linked, still-consistent row files nothing', () => {
  const found = runBoardLinkChecks({
    boardRows: [row({ personId: 5 })],
    layer: layer({
      people: [JOHN], units: [{ person_id: 5, unit_number: '001', fleet_type: 'company', seat: 1 }],
    }),
  });
  assert.deepEqual(found, []);
});

test('an absent row is history, not today — nothing is filed about it', () => {
  const found = runBoardLinkChecks({
    boardRows: [row({ present: false })], layer: layer({ people: [JOHN] }),
  });
  assert.deepEqual(found, []);
});

test('a merged person is never a candidate', () => {
  const found = runBoardLinkChecks({
    boardRows: [row()],
    layer: layer({ people: [{ ...JOHN, merged_into_person_id: 99 }] }),
  });
  assert.equal(found[0].checkKey, CHECKS.UNMATCHED);
});

test('a team files one finding per member, keyed separately', () => {
  const found = runBoardLinkChecks({
    boardRows: [row({
      rowKey: '001|JOHN SMITH', isTeam: true, teamMembers: ['JOHN SMITH', 'MARIA GARCIA'],
    })],
    layer: layer({ people: [JOHN, MARIA] }),
  });
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.subjectId).sort(), [
    '001|JOHN SMITH|JOHN SMITH', '001|JOHN SMITH|MARIA GARCIA',
  ]);
  for (const f of found) assert.equal(f.evidence.isTeam, true);
});

test('a team collapsing onto one person needs a person, and proposes nothing', () => {
  const found = runBoardLinkChecks({
    boardRows: [row({ isTeam: true, teamMembers: ['JOHN SMITH', 'MARIA GARCIA'] })],
    layer: layer({
      people: [{ id: 7, display_name: 'JOHN SMITH MARIA GARCIA', merged_into_person_id: null }],
    }),
  });
  for (const f of found) {
    assert.equal(f.checkKey, CHECKS.TEAM_SPLIT);
    assert.equal(f.tier, 'approval');
    assert.equal(f.proposedChange, null);
  }
});

test('no board and no layer file nothing rather than throwing', () => {
  assert.deepEqual(runBoardLinkChecks({ boardRows: [], layer: null }), []);
  assert.deepEqual(runBoardLinkChecks({ boardRows: null, layer: layer() }), []);
  assert.deepEqual(runBoardLinkChecks({}), []);
});

test('no finding carries a phone number', () => {
  const found = runBoardLinkChecks({
    boardRows: [row({ phone: '+15555550001' })], layer: layer({ people: [JOHN] }),
  });
  const published = JSON.stringify(found);
  assert.ok(!published.includes('5555550001'), published);
});

test('every key this module emits is declared', () => {
  const emitted = new Set();
  const scenarios = [
    { boardRows: [row()], layer: layer({ people: [JOHN], units: [{ person_id: 5, unit_number: '001', fleet_type: 'company', seat: 1 }] }) },
    { boardRows: [row()], layer: layer({ people: [JOHN] }) },
    { boardRows: [row()], layer: layer({ people: [MARIA], units: [{ person_id: 6, unit_number: '001', fleet_type: 'company', seat: 1 }] }) },
    { boardRows: [row()], layer: layer() },
    { boardRows: [row({ isTeam: true, teamMembers: ['A B', 'C D'] })], layer: layer({ people: [{ id: 7, display_name: 'A B C D', merged_into_person_id: null }] }) },
  ];
  for (const s of scenarios) for (const f of runBoardLinkChecks(s)) emitted.add(f.checkKey);
  for (const key of emitted) assert.ok(CHECK_KEYS.includes(key), `${key} is not in CHECK_KEYS`);
});

test('IT READS THE SHAPE `loadSnapshot` ACTUALLY PRODUCES', () => {
  // The person layer is SPREAD across the snapshot (`...layer`), not nested
  // under a `layer` key. The first version of this module read `snapshot.layer`,
  // found undefined, and filed nothing — silently, looking exactly like a fleet
  // with nothing to link. Every unit test passed, because they all handed it
  // the nested shape the code expected rather than the one the loader makes.
  const flat = {
    now: new Date(),
    groups: [], profiles: [], roadHistory: [], homeStatus: [], settings: {},
    boardRows: [row()],
    // …spread, exactly as services/operations/snapshot/loaders.js does it:
    people: [JOHN],
    units: [{ person_id: 5, unit_number: '001', fleet_type: 'company', seat: 1 }],
    personGroups: [], personGroupHistory: [], fuelAlerts: [],
  };
  const [found] = runBoardLinkChecks(flat);
  assert.ok(found, 'the flat snapshot produced no finding');
  assert.equal(found.checkKey, 'board.person_link');
});

test('a snapshot with no person layer at all files nothing rather than throwing', () => {
  assert.deepEqual(runBoardLinkChecks({ boardRows: [row()] }), []);
});
