'use strict';

/**
 * The board service that replaced the Apps Script spreadsheet (November 2026):
 * its rows under `trucks`, the fleet as a suffix of the truck (`021 CMP`), a
 * team as `driver` + `team_driver`, `team` as the DISPATCHER's team, the two
 * new status words, and a key that travels only in a header.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  splitBoardTruck, fleetTypeFromTruckSuffix, readBoardTruck, describeTruckSuffix,
} = require('../lib/board/truckSuffix');
const { parseBoardPayload, summariseBoardPayload } = require('../lib/board/parse');
const semantics = require('../lib/board/statusSemantics');
const { fetchBoard } = require('../services/dispatchBoard/client');
const { boardApiFromEnv, DEFAULT_BOARD_API_URL } = require('../database/dispatchBoardSettings');

test('the truck column splits into a unit (leading zeros kept) and a suffix', () => {
  assert.deepEqual(splitBoardTruck('021 CMP'), { unit: '021', suffix: 'CMP' });
  assert.deepEqual(splitBoardTruck('  310   javlon '), { unit: '310', suffix: 'JAVLON' });
  assert.deepEqual(splitBoardTruck('045'), { unit: '045', suffix: null });
  assert.deepEqual(splitBoardTruck('#127 L'), { unit: '127', suffix: 'L' });
  assert.deepEqual(splitBoardTruck('001A RALPH'), { unit: '001A', suffix: 'RALPH' }, 'a letter written onto the number is the unit');
  assert.deepEqual(splitBoardTruck('001a'), { unit: '001A', suffix: null });
  assert.deepEqual(splitBoardTruck('021CMP'), { unit: '021', suffix: 'CMP' }, 'a fleet word is never part of the unit');
  assert.deepEqual(splitBoardTruck('077 (Polvan)'), { unit: '077', suffix: '(POLVAN)' });
  assert.deepEqual(splitBoardTruck('OFFICE'), { unit: 'OFFICE', suffix: null });
  assert.deepEqual(splitBoardTruck(''), { unit: null, suffix: null });
});

test("the owner's fleet reading of the suffix (5 November 2026)", () => {
  // Company drivers: the company's, an investor's or a vendor's truck.
  assert.deepEqual(describeTruckSuffix('COMP'), { fleetType: 'company', detail: 'company_truck' });
  assert.deepEqual(describeTruckSuffix('CMP'), { fleetType: 'company', detail: 'investor_truck' });
  assert.deepEqual(describeTruckSuffix('CPM'), { fleetType: 'company', detail: 'investor_truck' }, 'CPM is CMP');
  assert.deepEqual(describeTruckSuffix('V'), { fleetType: 'company', detail: 'vendor_truck' });
  // R is lease to rent; L bought the truck from us and counts as an owner-operator.
  assert.deepEqual(describeTruckSuffix('R'), { fleetType: 'lease', detail: 'lease_to_rent' });
  assert.deepEqual(describeTruckSuffix('L'), { fleetType: 'owner_operator', detail: 'lease_to_own' });
  // A driver's name, bracketed or not, and no suffix at all: an owner-operator.
  for (const s of ['JAVLON', '(POLVAN)', 'A RALPH', null, '']) {
    assert.deepEqual(describeTruckSuffix(s), { fleetType: 'owner_operator', detail: 'own_truck' }, String(s));
  }
  assert.equal(fleetTypeFromTruckSuffix('2B'), 'unknown');
  assert.equal(readBoardTruck('OFFICE').fleetType, 'unknown', 'no number, no fleet');
  assert.deepEqual(readBoardTruck('001A RALPH'), { unit: '001A', suffix: 'RALPH', fleetType: 'owner_operator', detail: 'own_truck' });
});

const ANSWER = {
  generated_at: '2026-11-04T16:00:00+00:00',
  count: 5,
  trucks: [
    { team: "Tim's Team", truck: '003 CPM', driver: 'Tom Doe', team_driver: null, phone: '+15555550001', status: 'HOME', eta: 'HOME',
      load_status: null, load_number: null, row_updated_at: '2026-10-29T20:25:02+00:00', location: null, location_at: null, appointment: null, speed_mph: null, last_updated_by: 'Ann' },
    { team: "Cody's Team", truck: '127 L', driver: 'Dan Hill', team_driver: 'Cal Hill', status: 'DISPATCHED' },
    { team: "Cody's Team", truck: '045', driver: 'Ann Oak', status: 'HOLD FOR LOAD' },
    { team: "Tim's Team", truck: '310 JAVLON', driver: 'Javlon K', status: 'COVERED' },
    { team: "Tim's Team", truck: '001 V', driver: null, status: 'READY' },
  ],
};

test('rows under `trucks` are read as the board service: unit, fleet, team, statuses', () => {
  const parsed = parseBoardPayload(ANSWER);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.format, 'board_api');
  assert.equal(parsed.generatedAt, '2026-11-04T16:00:00+00:00');
  const [home, team, owner, covered, empty] = parsed.rows;

  assert.equal(home.truckRaw, '003 CPM');
  assert.equal(home.truckNorm, '003', 'the unit Wenze knows, without the fleet suffix');
  assert.equal(home.fleetType, 'company');
  assert.equal(home.isTeam, false, "the dispatcher's team is not a two-driver crew");
  assert.equal(home.dispatcher, null);

  assert.equal(team.fleetType, 'owner_operator', 'L: lease to own');
  assert.equal(team.fleetDetail, 'lease_to_own');
  assert.equal(team.isTeam, true);
  assert.deepEqual(team.teamMembers, ['Dan Hill', 'Cal Hill']);
  assert.equal(team.teamFlagMismatch, false);

  assert.equal(owner.fleetType, 'owner_operator');
  assert.equal(owner.status, 'HOLD FOR LOAD');
  assert.equal(covered.fleetType, 'owner_operator', "a driver's name after the number");
  assert.equal(empty.fleetType, 'company');
  assert.equal(empty.fleetDetail, 'vendor_truck');
  assert.equal(empty.driverNameRaw, null);

  const kinds = parsed.problems.map((p) => p.kind);
  assert.ok(!kinds.includes('unknown_field'), JSON.stringify(parsed.problems));
  assert.ok(!kinds.includes('unknown_status'));
  assert.ok(!kinds.includes('team_flag_mismatch'));
  assert.deepEqual(kinds, ['row_without_driver']);
});

test('the summary counts each fleet and its shade, and next_stop is not an unknown column', () => {
  const parsed = parseBoardPayload({
    trucks: [
      { truck: '021 CMP', driver: 'A', status: 'HOME', next_stop: 'Dallas, TX' },
      { truck: '022 COMP', driver: 'B', status: 'HOME' },
      { truck: '266116 R', driver: 'C', team_driver: 'D', status: 'ENROUTE' },
      { truck: '2614 L', driver: 'E', status: 'SHOP' },
      { truck: '757 AKBAR', driver: 'F', status: 'DISPATCHED' },
    ],
  });
  const summary = summariseBoardPayload(parsed);
  assert.deepEqual(summary.fleet, { company: 2, lease: 1, owner_operator: 2, unknown: 0 });
  assert.deepEqual(summary.fleetDetail, {
    investor_truck: 1, company_truck: 1, lease_to_rent: 1, lease_to_own: 1, own_truck: 1,
  });
  assert.ok(!parsed.problems.some((p) => p.kind === 'unknown_field'), JSON.stringify(parsed.problems));
});

test('a corrected suffix does not make a line look new', () => {
  const a = parseBoardPayload({ trucks: [{ truck: '021 CMP', driver: 'Ann Oak', status: 'HOME' }] }).rows[0];
  const b = parseBoardPayload({ trucks: [{ truck: '021 CPM', driver: 'Ann Oak', status: 'HOME' }] }).rows[0];
  assert.equal(a.rowKey, b.rowKey);
});

test('the old spreadsheet is still read the old way', () => {
  const parsed = parseBoardPayload({ rows: [{ driver_name: 'JOHN SMITH (LEASE DRIVER)', truck: '001A', status: 'HOME', is_team: false }] });
  assert.equal(parsed.format, 'sheet');
  assert.equal(parsed.rows[0].fleetType, 'lease');
  assert.equal(parsed.rows[0].truckNorm, '001A');
});

test('COVERED and HOLD FOR LOAD mean working, and end a home stay', () => {
  for (const s of ['COVERED', 'HOLD FOR LOAD', 'hold  for load']) {
    assert.equal(semantics.boardSaysWorking(s), true, s);
    assert.equal(semantics.boardEndsHomeStay(s), true, s);
    assert.equal(semantics.boardSaysHome(s), false, s);
  }
  assert.equal(semantics.boardEndsHomeStay('REST'), false);
});

function answer(body, { status = 200, headers = {} } = {}) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[String(k).toLowerCase()] ?? null }, async text() { return text; } };
}

test('the key travels in a header — never in the URL — and no redirect is followed', async () => {
  const KEY = 'wz_test_key_ThatMustNeverAppear';
  const calls = [];
  const ok = await fetchBoard({ baseUrl: DEFAULT_BOARD_API_URL, token: KEY, auth: 'header' }, {
    fetchImpl: async (url, init) => { calls.push({ url, init }); return answer(ANSWER); },
  });
  assert.equal(ok.json.count, 5);
  assert.equal(calls[0].url, DEFAULT_BOARD_API_URL);
  assert.ok(!calls[0].url.includes(KEY));
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);

  await assert.rejects(
    fetchBoard({ baseUrl: DEFAULT_BOARD_API_URL, token: KEY, auth: 'header' }, {
      fetchImpl: async () => answer({}, { status: 302, headers: { location: 'https://elsewhere.example.com/' } }),
    }),
    (err) => err.kind === 'too_many_redirects' && !err.message.includes(KEY),
  );
});

test('the connection comes from Settings → Secrets when DISPATCH_BOARD_API_KEY is set', () => {
  assert.equal(boardApiFromEnv({}), null);
  assert.deepEqual(boardApiFromEnv({ DISPATCH_BOARD_API_KEY: ' k ' }), {
    baseUrl: DEFAULT_BOARD_API_URL, token: 'k', auth: 'header', source: 'secrets',
  });
  assert.equal(boardApiFromEnv({ DISPATCH_BOARD_API_KEY: 'k', DISPATCH_BOARD_API_URL: 'https://b.example.com/api' }).baseUrl, 'https://b.example.com/api');
  assert.equal(DEFAULT_BOARD_API_URL, 'https://board.wenzellc.com/api/public/v1/board');
});

test('on the spreadsheet `team` is still the crew flag; on the board service it is not', () => {
  const sheet = parseBoardPayload({ rows: [{ driver_name: 'ONE PERSON', truck: '27', status: 'HOME', team: true }] });
  assert.equal(sheet.rows[0].isTeam, true);
  const api = parseBoardPayload({ trucks: [{ truck: '027 CMP', driver: 'One Person', team: 'true', status: 'HOME' }] });
  assert.equal(api.rows[0].isTeam, false);
});

test('a line with only the second seat filled is that one driver, not an empty line', () => {
  const parsed = parseBoardPayload({ trucks: [{ truck: '127 L', driver: null, team_driver: 'Cal Hill', status: 'HOME' }] });
  assert.equal(parsed.rows[0].driverNameRaw, 'Cal Hill');
  assert.equal(parsed.rows[0].isTeam, false);
  assert.ok(!parsed.problems.some((p) => p.kind === 'row_without_driver'));
});

test('the key is never sent to an http:// address', async () => {
  assert.equal(boardApiFromEnv({ DISPATCH_BOARD_API_KEY: 'k', DISPATCH_BOARD_API_URL: 'http://b.example.com/api' }).baseUrl, null);
  let called = false;
  await assert.rejects(
    fetchBoard({ baseUrl: 'http://b.example.com/api', token: 'k-secret-0000', auth: 'header' }, {
      fetchImpl: async () => { called = true; return answer({}); },
    }),
    (err) => err.kind === 'bad_url' && !err.message.includes('k-secret-0000'),
  );
  assert.equal(called, false);
});
