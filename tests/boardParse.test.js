'use strict';

/**
 * The Dispatcher Board is a spreadsheet with an HTTP wrapper. Its JSON is not a
 * contract — a column gets renamed, a field arrives as a number, somebody
 * republishes the array under a different key — and the poller that reads it is
 * how Wenze learns who is in which truck. So the parser bends and reports;
 * it never throws, and it never guesses.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseBoardPayload, summariseBoardPayload, detectTeam, parseStatus,
} = require('../lib/board/parse');

/** The shapes the live Board is known to carry, in one fixture. */
const FIXTURE = {
  board_date: '2026-09-11',
  generated_at: '2026-09-11T23:00:00Z',
  count: 6,
  rows: [
    {
      row: 2,
      driver_name: 'JOHN SMITH (COMPANY DRIVER)',
      truck: '001',
      trailer: 'T-118',
      phone: '+15555550001',
      status: 'HOME',
      eta: '',
      origin_delivery: 'CHICAGO IL > DALLAS TX',
      notes: 'back Monday',
      dispatcher: 'Ann',
      is_team: false,
    },
    { row: 3, driver_name: 'A ONE / B TWO (LEASE DRIVERS)', truck: '#310', status: 'DISPATCHED', is_team: true },
    { row: 4, driver_name: 'C THREE (COMPNAY DRIVER)', truck: '001A', status: 'shop' },
    { row: 5, driver_name: 'D FOUR', truck: '27', status: 'ENROUTE' },
    { row: 6, driver_name: 'E FIVE (RESERVED FOR OFFICE)', truck: '99', status: 'WAT' },
    { row: 7, driver_name: 'F SIX / G SEVEN', truck: '2771', status: 'READY', is_team: false },
  ],
};

test('every fleet label the Board writes is read, and the typo is named', () => {
  const parsed = parseBoardPayload(FIXTURE);
  const byRow = Object.fromEntries(parsed.rows.map((r) => [r.sheetRow, r]));

  assert.equal(byRow[2].fleetType, 'company');
  assert.equal(byRow[3].fleetType, 'lease');
  assert.equal(byRow[4].fleetType, 'company');
  assert.equal(byRow[4].fleetLabelNormalised, true, 'accepting a typo is a fact the finding carries');
  // No label at all is the Board's own owner-operator convention — NOT unknown.
  assert.equal(byRow[5].fleetType, 'owner_operator');
  assert.equal(byRow[5].fleetLabelNormalised, false);
  assert.equal(byRow[6].fleetType, 'unknown', 'a label outside the list is never a closest guess');
});

test('the label is taken out of the name, so the person is left behind', () => {
  const parsed = parseBoardPayload(FIXTURE);
  assert.equal(parsed.rows[0].cleanName, 'JOHN SMITH');
  assert.equal(parsed.rows[0].driverNameRaw, 'JOHN SMITH (COMPANY DRIVER)');
});

test('a team is found by the flag or by the separator, and a disagreement is reported', () => {
  const parsed = parseBoardPayload(FIXTURE);
  const byRow = Object.fromEntries(parsed.rows.map((r) => [r.sheetRow, r]));

  assert.equal(byRow[3].isTeam, true);
  assert.deepEqual(byRow[3].teamMembers, ['A ONE', 'B TWO']);
  assert.equal(byRow[3].teamFlagMismatch, false);

  // Typed as a pair, flagged as one person. Which is right is a human question.
  assert.equal(byRow[7].isTeam, true);
  assert.equal(byRow[7].teamFlagMismatch, true);
  assert.ok(parsed.problems.some((p) => p.kind === 'team_flag_mismatch'));
});

test('the truck keeps its identity, and carries the weak key beside it', () => {
  const parsed = parseBoardPayload(FIXTURE);
  const byRow = Object.fromEntries(parsed.rows.map((r) => [r.sheetRow, r]));
  assert.equal(byRow[2].truckNorm, '001');
  assert.equal(byRow[2].truckDigits, '1');
  assert.equal(byRow[4].truckNorm, '001A');
  assert.equal(byRow[3].truckNorm, '310');
});

test('free text is stored exactly as the dispatcher typed it', () => {
  const parsed = parseBoardPayload(FIXTURE);
  const row = parsed.rows[0];
  assert.equal(row.originDelivery, 'CHICAGO IL > DALLAS TX');
  assert.equal(row.notes, 'back Monday');
  assert.equal(row.dispatcher, 'Ann');
  assert.equal(row.boardTrailer, 'T-118', 'the Board field is board_trailer, never a trailer feature');
});

test('a status nobody has seen keeps its spelling and is reported', () => {
  const parsed = parseBoardPayload(FIXTURE);
  const unknown = parsed.rows.find((r) => r.sheetRow === 6);
  assert.equal(unknown.status, 'WAT');
  assert.equal(unknown.statusRaw, 'WAT');
  assert.ok(parsed.problems.some((p) => p.kind === 'unknown_status'));
  // A known status in the wrong case is still known.
  assert.equal(parseStatus('shop').status, 'SHOP');
  assert.equal(parseStatus('shop').known, true);
});

test('a column the parser does not know is reported BY NAME, never by value', () => {
  const parsed = parseBoardPayload({
    rows: [{ driver_name: 'H EIGHT', truck: '5', status: 'READY', ssn: '123-45-6789' }],
  });
  const unknown = parsed.problems.filter((p) => p.kind === 'unknown_field');
  assert.deepEqual(unknown.map((p) => p.field), ['ssn']);
  assert.equal(JSON.stringify(parsed.problems).includes('123-45-6789'), false);
});

test('a column that is present but empty is recognised, not reported', () => {
  const parsed = parseBoardPayload({
    rows: [{ driver_name: 'I NINE', truck: '6', status: 'READY', notes: '', eta: '' }],
  });
  assert.deepEqual(parsed.problems.filter((p) => p.kind === 'unknown_field'), []);
});

test('the rows are found however the script publishes them', () => {
  for (const key of ['rows', 'drivers', 'data', 'items', 'records']) {
    const parsed = parseBoardPayload({ [key]: [{ driver_name: 'J TEN', truck: '8', status: 'READY' }] });
    assert.equal(parsed.ok, true, key);
    assert.equal(parsed.count, 1, key);
  }
  // And a script that returns the bare array with no envelope at all.
  const bare = parseBoardPayload([{ driver_name: 'K', truck: '9', status: 'READY' }]);
  assert.equal(bare.count, 1);
});

test('a payload with no rows says so instead of throwing', () => {
  const parsed = parseBoardPayload({ message: 'unauthorised' });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.rows.length, 0);
  const problem = parsed.problems.find((p) => p.kind === 'no_rows_found');
  // The KEY NAMES are what tells us the shape changed; the values are fleet data.
  assert.deepEqual(problem.fields, ['message']);
});

test('nothing in the payload can make the parser throw', () => {
  for (const input of [null, undefined, 0, '', 'a string', { rows: 'not an array' }, { rows: [null, 3, 'x'] }]) {
    assert.doesNotThrow(() => parseBoardPayload(input), JSON.stringify(input));
  }
  const junk = parseBoardPayload({ rows: [null, 3, 'x'] });
  assert.equal(junk.problems.filter((p) => p.kind === 'row_not_an_object').length, 3);
});

test('two rows with one identity are both kept, and the collision is reported', () => {
  const parsed = parseBoardPayload({
    rows: [
      { driver_name: 'L ELEVEN (COMPANY DRIVER)', truck: '001', status: 'READY' },
      { driver_name: 'L ELEVEN (COMPANY DRIVER)', truck: '#001', status: 'HOME' },
    ],
  });
  assert.equal(parsed.rows.length, 2, 'dropping one would silently lose a driver');
  assert.ok(parsed.problems.some((p) => p.kind === 'duplicate_row_key'));
});

test('the summary is counts only — nothing from the Board travels in it', () => {
  const parsed = parseBoardPayload(FIXTURE);
  const summary = summariseBoardPayload(parsed);
  assert.equal(summary.count, 6);
  assert.deepEqual(summary.fleet, { company: 2, lease: 1, owner_operator: 2, unknown: 1 });
  assert.equal(summary.teams, 2);
  assert.equal(summary.normalisedLabels, 1);
  const text = JSON.stringify(summary);
  for (const secret of ['JOHN SMITH', '+15555550001', 'T-118', 'back Monday', 'Ann']) {
    assert.ok(!text.includes(secret), `${secret} must not reach a summary`);
  }
});

test('detectTeam reads the flag in every spelling a sheet produces', () => {
  for (const yes of [true, 'true', 'TRUE', 'yes', 'Y', 1, '1']) {
    assert.equal(detectTeam('SOLO NAME', yes).isTeam, true, String(yes));
  }
  for (const no of [false, 'false', 'no', 0, '', null, undefined, 'maybe']) {
    assert.equal(detectTeam('SOLO NAME', no).isTeam, false, String(no));
  }
});
