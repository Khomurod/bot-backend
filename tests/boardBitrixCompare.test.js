'use strict';

/**
 * Board ↔ Bitrix: every difference, as data — on records shaped like the
 * portal's own (29 October 2026). The Board is the source of truth: each
 * discrepancy is something to correct in Bitrix, and one situation is ONE
 * question, never a "missing" and a "not on the Board" about the same seat.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { compareBoardWithBitrix, boardPeople } = require('../lib/boardBitrix/compare');
const { questionFor, factsFor } = require('../lib/boardBitrix/wording');

const ON_ROAD = 'DT1040_17:UC_90RJVZ';
const WORKING = 'C3:UC_XZ955I';

const row = (over) => ({
  present: true, cleanName: 'OLABODE OLUDAISI', fleetType: 'owner_operator', truckNorm: '001', status: 'DISPATCHED', teamMembers: [], ...over,
});
const deal = (over) => ({
  id: 321, title: 'OLABODE OLUDAISI ', stageId: WORKING, semantic: 'P', fleetType: 'owner_operator', truckId: 3, ...over,
});
const truck = (over) => ({ id: 3, title: 'Trucks #001', stageId: ON_ROAD, ...over });

const kinds = (out) => out.discrepancies.map((d) => d.key);
const run = (boardRows, deals, trucks) => compareBoardWithBitrix({ boardRows, deals, trucks });

test('everything agrees: nothing to ask, and the pairing is counted', () => {
  const out = run([row()], [deal()], [truck()]);
  assert.deepEqual(out.discrepancies, []);
  assert.equal(out.counts.paired, 1);
  assert.equal(out.counts.activeTrucks, 1);
});

test('a small name difference on the right truck is the same driver — no question (the owner\'s rule)', () => {
  const out = run([row({ cleanName: 'OLUDAISI OLABODE' })], [deal({ title: 'OLABODE OLUDAYSI' })], [truck()]);
  assert.deepEqual(kinds(out), []);
});

test('Company 001 and Owner-Operator 001 are two trucks: each driver pairs with their own', () => {
  const out = run(
    [row(), row({ cleanName: 'JOHN DOE', fleetType: 'company' })],
    [deal(), deal({ id: 400, title: 'JOHN DOE', fleetType: 'company', truckId: 207 })],
    [truck(), truck({ id: 207, title: 'Truck #001' })],
  );
  assert.deepEqual(kinds(out), []);
  assert.equal(out.counts.paired, 2);
});

test('a team: one Board line with two names, two deals on one truck — both paired, nothing asked', () => {
  const out = run(
    [row({ cleanName: 'ABDINASIR / IBRAHIM', isTeam: true, teamMembers: ['ABDINASIR', 'IBRAHIM'], fleetType: 'lease', truckNorm: '311' })],
    [deal({ id: 155, title: 'ABDINASIR  ', fleetType: 'lease', truckId: 115 }), deal({ id: 157, title: 'IBRAHIM  ', fleetType: 'lease', truckId: 115 })],
    [truck({ id: 115, title: 'Trucks #311' })],
  );
  assert.deepEqual(kinds(out), []);
  assert.equal(boardPeople([row({ teamMembers: ['ANNA BELL', 'CARL DANE'] })]).length, 2);
});

test('the truck, driver type and status are each their own question; the expected stage follows the Board', () => {
  const out = run(
    [row({ status: 'HOME', fleetType: 'company', truckNorm: '310' })],
    [deal({ fleetType: 'owner_operator', truckId: 3 })],
    [truck()],
  );
  assert.deepEqual(kinds(out).sort(), ['fleet_differs:deal:321', 'status_differs:deal:321', 'truck_differs:deal:321']);
  assert.equal(out.discrepancies.find((d) => d.kind === 'status_differs').expectedStageId, 'C3:UC_UF0NDK');
});

test('READY, RESERVED and REST are WORKING; NEW in Bitrix for a driver on the Board is a status to fix', () => {
  for (const status of ['READY', 'RESERVED', 'REST', 'ENROUTE']) {
    assert.deepEqual(kinds(run([row({ status })], [deal()], [truck()])), [], status);
  }
  assert.deepEqual(kinds(run([row()], [deal({ stageId: 'C3:NEW' })], [truck()])), ['status_differs:deal:321']);
  assert.deepEqual(kinds(run([row({ status: 'SOMETHING NEW' })], [deal({ stageId: 'C3:NEW' })], [truck()])), [],
    'a status the Board invents is never a conclusion');
});

test('driver type empty in Bitrix, no truck assigned, the truck not on the road', () => {
  assert.deepEqual(kinds(run([row()], [deal({ fleetType: null })], [truck()])), ['fleet_missing:deal:321']);
  assert.deepEqual(kinds(run([row()], [deal({ truckId: null })], [truck()])).sort(), ['truck_missing:deal:321', 'truck_without_driver:truck:3']);
  assert.deepEqual(kinds(run([row()], [deal()], [truck({ stageId: 'DT1040_17:FAIL' })])), ['truck_inactive:truck:3']);
  assert.deepEqual(kinds(run([row({ status: 'VACATION' })], [deal({ stageId: 'C3:UC_XVD661' })], [truck({ stageId: 'DT1040_17:FAIL' })])), [],
    'a driver on vacation may have handed the truck back');
});

test('on the Board only: closed in Bitrix (newest closed deal named), or no deal at all', () => {
  const closed = run([row()], [deal({ semantic: 'F', stageId: 'C3:LOSE', id: 100 }), deal({ semantic: 'F', stageId: 'C3:LEFT', id: 200 })], [truck({ stageId: 'DT1040_17:FAIL' })]);
  assert.deepEqual(kinds(closed), ['inactive_in_bitrix:deal:200']);
  const none = run([row({ cleanName: 'NEW PERSON HERE', truckNorm: '999' })], [], []);
  assert.deepEqual(kinds(none), ['missing_in_bitrix:person:HERE NEW PERSON']);
});

test('active in Bitrix only — a NEW deal too — is "not on the Board"; its truck is not asked about separately', () => {
  const out = run([], [deal({ stageId: 'C3:NEW' })], [truck()]);
  assert.deepEqual(kinds(out), ['not_on_board:deal:321']);
});

test('one seat, two different names: ONE question about the truck, not a missing and a not-on-board', () => {
  const out = run([row({ cleanName: 'JAMES BROWN' })], [deal({ title: 'OLABODE OLUDAISI' })], [truck()]);
  assert.deepEqual(kinds(out), ['name_differs:truck:owner_operator:001']);
  const q = questionFor(out.discrepancies[0]);
  assert.match(q.title, /Truck 001: the name on the Board and in Bitrix differ/);
  assert.ok(q.lines.some((l) => l.includes('JAMES BROWN')) && q.lines.some((l) => l.includes('OLABODE OLUDAISI')));
});

test('a team on the Board whose truck is spelled "1" and "001" is one seat question naming both, neither also missing', () => {
  const out = run(
    [row({ cleanName: 'JAMES BROWN / MARK GREEN', teamMembers: ['JAMES BROWN', 'MARK GREEN'], truckNorm: '1' })],
    [deal({ title: 'OLABODE OLUDAISI' })],
    [truck()],
  );
  assert.deepEqual(kinds(out), ['name_differs:truck:owner_operator:1']);
  assert.deepEqual(out.discrepancies[0].board.map((p) => p.name), ['JAMES BROWN', 'MARK GREEN']);
});

test('an UNKNOWN fleet never wins a choice between two trucks with one number; a known fleet never takes another fleet\'s deal', () => {
  const two = [deal({ id: 1, title: 'OLABODE OLUDAISI', fleetType: 'company', truckId: 3 }), deal({ id: 2, title: 'OTHER PERSON', fleetType: 'lease', truckId: 207 })];
  const trucks = [truck(), truck({ id: 207, title: 'Truck #001' })];
  const unknown = run([row({ cleanName: 'OLABODE', fleetType: 'unknown' })], two, trucks);
  assert.ok(!unknown.discrepancies.some((d) => d.kind === 'name_differs'), 'no seat question mixing two trucks');
  const lease = run([row({ cleanName: 'JAMES BROWN', fleetType: 'lease' })], [deal({ title: 'OLABODE OLUDAISI', fleetType: 'company' })], [truck()]);
  assert.deepEqual(kinds(lease).sort(), ['missing_in_bitrix:person:BROWN JAMES', 'not_on_board:deal:321'], 'Company 001 is not Lease 001');
  const empty = run([row({ fleetType: 'company' })], [deal({ fleetType: null })], [truck()]);
  assert.deepEqual(kinds(empty), ['fleet_missing:deal:321'], 'a deal with no driver type may still be the seat');
});

test('two active deals for one driver, and a deal titled with two people', () => {
  const dup = run([row({ truckNorm: null })], [deal({ id: 10, truckId: null }), deal({ id: 11, truckId: null })], []);
  assert.deepEqual(kinds(dup), ['duplicate_deals:person:OLABODE OLUDAISI']);
  const two = run(
    [row({ cleanName: 'PRINCE / OTIS', teamMembers: ['PRINCE', 'OTIS'], truckNorm: '500' })],
    [deal({ id: 4765, title: 'Prince/Otis', truckId: null })],
    [],
  );
  assert.deepEqual(kinds(two), ['two_names_in_deal:deal:4765'], 'the people it names are not also "missing"');
});

test('an active truck no active deal points at; a placeholder Board line is nobody', () => {
  const out = run([row({ cleanName: 'OPEN', truckNorm: '330' })], [], [truck({ id: 429, title: 'Truck# 330' })]);
  assert.deepEqual(kinds(out), ['truck_without_driver:truck:429']);
});

test('keys name the subject, never the values: a question whose details change stays one question', () => {
  const a = run([row({ truckNorm: '310' })], [deal()], [truck()]);
  const b = run([row({ truckNorm: '312' })], [deal()], [truck()]);
  assert.deepEqual(kinds(a), kinds(b));
  assert.notDeepEqual(a.discrepancies[0].board, b.discrepancies[0].board);
});

test('every kind has wording with the fix on the Bitrix side, and the deal link when the portal is known', () => {
  const out = run([row({ status: 'HOME', fleetType: 'company', truckNorm: '310' })], [deal({ fleetType: null })], [truck()]);
  const links = { dealUrl: (id) => `https://portal.example/crm/deal/details/${id}/`, waiting: 2 };
  for (const d of out.discrepancies) {
    const q = questionFor(d, links);
    assert.match(q.title, /^Board ↔ Bitrix: /);
    assert.ok(q.lines.some((l) => l.startsWith('What to change: ')), d.kind);
    assert.ok(q.lines.some((l) => l.includes('/crm/deal/details/321/')), d.kind);
    assert.match(q.lines[q.lines.length - 1], /2 more difference/);
    assert.match(q.action, /reply "done"/);
    assert.ok(factsFor(d).length > 0);
  }
});
