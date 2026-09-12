'use strict';

/**
 * The Dispatcher Board checks.
 *
 * The one worth the most attention is `board.truck_on_multiple_rows`. The
 * authority model says a truck number alone is NEVER globally unique —
 * Company 001, Owner-Operator 001 and Lease 001 are three trucks — so a check
 * that bucketed on the bare number would file a finding about each of them and
 * train an operator to ignore the whole page. Half these tests are about the
 * pairs that must NOT be reported.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  runBoardChecks, CHECK_KEYS,
  checkUnknownFleetLabel, checkFleetLabelTypo, checkUnknownStatus,
  checkTeamFlagMismatch, checkTruckOnMultipleRows, checkRowVanished,
  VANISHED_WINDOW_DAYS,
} = require('../services/operations/checks/board');

function row(over = {}) {
  return {
    rowKey: 'X|X',
    cleanName: 'ALPHA ONE',
    fleetType: 'company',
    fleetLabelRaw: '(COMPANY DRIVER)',
    fleetLabelNormalised: false,
    isTeam: false,
    teamFlagMismatch: false,
    truckNorm: '001',
    truckDigits: '1',
    status: 'DISPATCHED',
    statusRaw: 'DISPATCHED',
    present: true,
    personId: null,
    firstSeenAt: new Date('2026-09-01T00:00:00Z'),
    lastSeenAt: new Date('2026-09-12T00:00:00Z'),
    ...over,
  };
}

const NOW = new Date('2026-09-12T12:00:00Z');

test('every key this module files is declared in CHECK_KEYS', () => {
  const board = [
    row({ rowKey: 'a', fleetType: 'unknown', fleetLabelRaw: '(CONTRACTOR)' }),
    row({ rowKey: 'b', fleetLabelNormalised: true, fleetLabelRaw: '(COMPNAY DRIVER)' }),
    row({ rowKey: 'c', status: 'ON VACATION??', statusRaw: 'on vacation??' }),
    row({ rowKey: 'd', teamFlagMismatch: true }),
    row({ rowKey: 'e', truckNorm: '900' }),
    row({ rowKey: 'f', truckNorm: '900' }),
    row({ rowKey: 'g', present: false, lastSeenAt: new Date('2026-09-11T00:00:00Z') }),
  ];
  const found = runBoardChecks({ boardRows: board, now: NOW });
  assert.ok(found.length > 0);
  for (const f of found) assert.ok(CHECK_KEYS.includes(f.checkKey), f.checkKey);
});

test('nothing at all is filed about a clean board', () => {
  const board = [row({ rowKey: 'a', truckNorm: '001' }), row({ rowKey: 'b', truckNorm: '002' })];
  assert.deepStrictEqual(runBoardChecks({ boardRows: board, now: NOW }), []);
});

test('an empty or missing board files nothing rather than throwing', () => {
  assert.deepStrictEqual(runBoardChecks({ boardRows: [], now: NOW }), []);
  assert.deepStrictEqual(runBoardChecks({ boardRows: undefined, now: NOW }), []);
});

test('an unreadable fleet label is a warning, and says it will not be matched', () => {
  const found = checkUnknownFleetLabel({
    boardRows: [row({ fleetType: 'unknown', fleetLabelRaw: '(CONTRACTOR)' })],
  });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].severity, 'warning');
  assert.strictEqual(found[0].tier, 'warning');
  assert.strictEqual(found[0].proposedChange, null);
  assert.match(found[0].evidence.consequence, /never matched/i);
});

test('an unlabelled row is an owner operator, not an unknown fleet', () => {
  const found = checkUnknownFleetLabel({
    boardRows: [row({ fleetType: 'owner_operator', fleetLabelRaw: null })],
  });
  assert.deepStrictEqual(found, []);
});

test('a label read through a typo is info, because nothing broke', () => {
  const found = checkFleetLabelTypo({
    boardRows: [row({ fleetLabelNormalised: true, fleetLabelRaw: '(COMPNAY DRIVER)' })],
  });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].severity, 'info');
  assert.strictEqual(found[0].evidence.readAs, 'company');
});

test('a status outside the vocabulary is reported; a known one is not', () => {
  assert.strictEqual(checkUnknownStatus({ boardRows: [row({ status: 'HOME' })] }).length, 0);
  assert.strictEqual(checkUnknownStatus({ boardRows: [row({ status: 'SHOP' })] }).length, 0);
  const found = checkUnknownStatus({ boardRows: [row({ status: 'PARKED', statusRaw: 'parked' })] });
  assert.strictEqual(found.length, 1);
  assert.match(found[0].title, /"parked"/);
});

test('a blank status is not an unknown status', () => {
  const found = checkUnknownStatus({ boardRows: [row({ status: 'UNKNOWN', statusRaw: null })] });
  assert.deepStrictEqual(found, []);
});

test('a team flag that disagrees with the name is a warning', () => {
  const found = checkTeamFlagMismatch({ boardRows: [row({ teamFlagMismatch: true })] });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].severity, 'warning');
  assert.strictEqual(found[0].proposedChange, null);
});

test('Company 001 and Owner-Operator 001 are two trucks, not a conflict', () => {
  const found = checkTruckOnMultipleRows({
    boardRows: [
      row({ rowKey: 'a', truckNorm: '001', fleetType: 'company' }),
      row({ rowKey: 'b', truckNorm: '001', fleetType: 'owner_operator' }),
      row({ rowKey: 'c', truckNorm: '001', fleetType: 'lease' }),
    ],
  });
  assert.deepStrictEqual(found, [], 'three fleets, three trucks');
});

test('two rows on one truck WITHIN a fleet is reported once, naming both', () => {
  const found = checkTruckOnMultipleRows({
    boardRows: [
      row({ rowKey: 'a', cleanName: 'ALPHA ONE', truckNorm: '001', fleetType: 'company' }),
      row({ rowKey: 'b', cleanName: 'BETA TWO', truckNorm: '001', fleetType: 'company' }),
      row({ rowKey: 'c', truckNorm: '002', fleetType: 'company' }),
    ],
  });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].subjectId, 'company|001');
  assert.strictEqual(found[0].evidence.rows.length, 2);
  assert.match(found[0].title, /as a company truck/);
});

test('an unknown-fleet row on the same number IS compared against every fleet', () => {
  const found = checkTruckOnMultipleRows({
    boardRows: [
      row({ rowKey: 'a', truckNorm: '001', fleetType: 'company' }),
      row({ rowKey: 'b', truckNorm: '001', fleetType: 'unknown', fleetLabelRaw: '(CONTRACTOR)' }),
    ],
  });
  assert.strictEqual(found.length, 1, 'we cannot tell them apart, so a person should look');
  assert.strictEqual(found[0].evidence.rows.length, 2);
});

test('a team is one row, so it never counts as two assignments', () => {
  const found = checkTruckOnMultipleRows({
    boardRows: [row({ rowKey: 'a', truckNorm: '001', isTeam: true, cleanName: 'ALPHA ONE / BETA TWO' })],
  });
  assert.deepStrictEqual(found, []);
});

test('an absent row is not on the truck any more', () => {
  const found = checkTruckOnMultipleRows({
    boardRows: [
      row({ rowKey: 'a', truckNorm: '001', present: true }),
      row({ rowKey: 'b', truckNorm: '001', present: false }),
    ],
  });
  assert.deepStrictEqual(found, []);
});

test('a row with no truck is never bucketed', () => {
  const found = checkTruckOnMultipleRows({
    boardRows: [row({ rowKey: 'a', truckNorm: null }), row({ rowKey: 'b', truckNorm: null })],
  });
  assert.deepStrictEqual(found, []);
});

test('a row that vanished this week is reported; one that vanished last month is not', () => {
  const recent = new Date(NOW.getTime() - 2 * 24 * 3600 * 1000);
  const old = new Date(NOW.getTime() - (VANISHED_WINDOW_DAYS + 3) * 24 * 3600 * 1000);
  const found = checkRowVanished({
    boardRows: [
      row({ rowKey: 'a', present: false, lastSeenAt: recent }),
      row({ rowKey: 'b', present: false, lastSeenAt: old }),
      row({ rowKey: 'c', present: true }),
    ],
    now: NOW,
  });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].subjectId, 'a');
  assert.strictEqual(found[0].severity, 'info');
});

test('no board finding proposes a change, because a spreadsheet is not evidence', () => {
  const board = [
    row({ rowKey: 'a', fleetType: 'unknown', fleetLabelRaw: '(CONTRACTOR)' }),
    row({ rowKey: 'b', fleetLabelNormalised: true }),
    row({ rowKey: 'c', status: 'PARKED' }),
    row({ rowKey: 'd', teamFlagMismatch: true }),
    row({ rowKey: 'e', truckNorm: '900' }), row({ rowKey: 'f', truckNorm: '900' }),
    row({ rowKey: 'g', present: false, lastSeenAt: NOW }),
  ];
  for (const f of runBoardChecks({ boardRows: board, now: NOW })) {
    assert.strictEqual(f.proposedChange, null, f.checkKey);
    assert.strictEqual(f.tier, 'warning', f.checkKey);
  }
});

test('a board finding never carries a phone number', () => {
  const board = [row({ rowKey: 'a', fleetType: 'unknown', fleetLabelRaw: '(CONTRACTOR)', phone: '+15550001111' })];
  const json = JSON.stringify(runBoardChecks({ boardRows: board, now: NOW }));
  assert.ok(!json.includes('5550001111'), json);
});

test('every board key has an operator-facing label in the admin', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../admin/src/pages/operations/labels.js'), 'utf8');
  for (const key of CHECK_KEYS) {
    assert.ok(src.includes(`'${key}':`), `no label for ${key}`);
  }
});

test('the sweep runs the board checks', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../services/operations/consistencyService'), 'utf8');
  assert.match(src, /name:\s*'board',\s*keys:\s*board\.CHECK_KEYS/);
});

test('two board lines Wenze cannot tell apart are reported, and nothing is guessed', () => {
  const { checkDuplicateRowKey } = require('../services/operations/checks/board');
  const found = checkDuplicateRowKey({
    boardRows: [row({ rowKey: 'a', keyCollision: true }), row({ rowKey: 'b' })],
  });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].checkKey, 'board.duplicate_row_key');
  assert.strictEqual(found[0].severity, 'warning');
  assert.strictEqual(found[0].proposedChange, null);
  assert.match(found[0].evidence.consequence, /only one of the two lines/i);
});
