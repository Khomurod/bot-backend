/**
 * Who is behind a driver group — the pure decision, on the three shapes that
 * actually happen in this fleet.
 *
 *   A driver changes truck. The old chat goes inactive, a new one appears with
 *   the same name. Before this, that was a NEW person and a road clock reset to
 *   zero (RUSLAN ABDULLAEV, group 49 → 541877, four weeks of accrual lost).
 *
 *   The same Telegram account texts from a new chat. One human, whatever the
 *   title says.
 *
 *   Two active drivers share a name. Linking either is a guess; the decision
 *   must refuse to make it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { decidePersonForGroup, decideUnitSync, NAME_LINK_CONFIDENCE } = require('../lib/identity/personResolution');

test('a group that already has a person keeps it — nothing else is consulted', () => {
  const decision = decidePersonForGroup({
    open: { personId: 7 },
    telegramAnchorPersonId: 9,
    returningCandidates: [{ personId: 11, openGroupIds: [3] }],
  });
  assert.deepEqual(decision, { action: 'keep', personId: 7 });
});

test('the same Telegram account elsewhere decides, over any name', () => {
  const decision = decidePersonForGroup({
    telegramAnchorPersonId: 9,
    returningCandidates: [{ personId: 11, openGroupIds: [3] }],
  });
  assert.equal(decision.action, 'link');
  assert.equal(decision.personId, 9);
  assert.equal(decision.source, 'telegram_user_id');
  assert.equal(decision.confidence, 100);
  assert.deepEqual(decision.closeGroupIds, [], 'the anchor person may legitimately hold two chats');
});

test('a returning driver — same name, every other chat inactive — is the SAME person, and the old chat is closed', () => {
  const decision = decidePersonForGroup({
    returningCandidates: [{ personId: 11, openGroupIds: [49] }],
  });
  assert.equal(decision.action, 'link');
  assert.equal(decision.personId, 11);
  assert.equal(decision.source, 'name_key');
  assert.equal(decision.confidence, NAME_LINK_CONFIDENCE);
  assert.deepEqual(decision.closeGroupIds, [49],
    'the person must end up with ONE open group, or every "current group" read is ambiguous');
});

test('nobody by that name: a new person', () => {
  const decision = decidePersonForGroup({ returningCandidates: [] });
  assert.deepEqual(decision, { action: 'create', ambiguous: false });
});

test('two inactive drivers with the same name: a new person, flagged ambiguous, never a guess', () => {
  const decision = decidePersonForGroup({
    returningCandidates: [{ personId: 11, openGroupIds: [1] }, { personId: 12, openGroupIds: [2] }],
  });
  assert.equal(decision.action, 'create');
  assert.equal(decision.ambiguous, true, 'the watchdog reports the coincidence; the resolver does not pick');
});

// ─── the truck ───────────────────────────────────────────────────────────────

test('no unit observed leaves the current truck alone', () => {
  assert.deepEqual(decideUnitSync({ personId: 1, currentUnit: '320', targetUnit: null }),
    { action: 'noop', reason: 'no_unit' });
  assert.deepEqual(decideUnitSync({ personId: 1, currentUnit: '320', targetUnit: '  ' }),
    { action: 'noop', reason: 'no_unit' });
});

test('the same truck is unchanged, even with stray whitespace', () => {
  assert.deepEqual(decideUnitSync({ personId: 1, currentUnit: '320', targetUnit: ' 320 ' }),
    { action: 'noop', reason: 'unchanged' });
});

test('a truck change is a switch — close 320, open 322 — and a first truck is an open', () => {
  // The answer now names the whole truck, not just its number: a seat (1 unless
  // this is a team's other half) and a fleet (`unknown` when the caller did not
  // say, which is honest and never wins a match).
  assert.deepEqual(decideUnitSync({ personId: 1, currentUnit: '320', targetUnit: '322' }),
    { action: 'switch', from: '320', to: '322', seat: 1, fleetType: 'unknown' });
  assert.deepEqual(decideUnitSync({ personId: 1, currentUnit: null, targetUnit: '322' }),
    { action: 'open', from: null, to: '322', seat: 1, fleetType: 'unknown' });
  assert.deepEqual(
    decideUnitSync({ personId: 1, currentUnit: null, targetUnit: '322', targetFleetType: 'company' }),
    { action: 'open', from: null, to: '322', seat: 1, fleetType: 'company' }
  );
});

test('a truck somebody else holds is contested, not taken', () => {
  const decision = decideUnitSync({ personId: 1, currentUnit: '320', targetUnit: '001', holderPersonId: 4 });
  assert.equal(decision.action, 'contested');
  assert.equal(decision.holderPersonId, 4);
  assert.equal(decision.unitNumber, '001');
});

test('the holder being the same person is not a contest', () => {
  // Can only happen when currentUnit is stale; the switch still wins.
  const decision = decideUnitSync({ personId: 1, currentUnit: null, targetUnit: '001', holderPersonId: 1 });
  assert.equal(decision.action, 'open');
});

test("'001', '01' and '1' are three different trucks — nothing normalises the zeros away", () => {
  const decision = decideUnitSync({ personId: 1, currentUnit: '01', targetUnit: '001' });
  assert.equal(decision.action, 'switch');
});

// ─── a truck is (fleet, number, seat) ────────────────────────────────────────

test('the same number in a DIFFERENT fleet is a different truck, not a contest', () => {
  // Production carries ten numbers on more than one active group, `001` on four.
  // Company 001 and Owner-Operator 001 are two trucks with two drivers.
  const decision = decideUnitSync({
    personId: 1, currentUnit: null, targetUnit: '001', targetFleetType: 'company',
    holders: [{ personId: 4, seat: 1, fleetType: 'owner_operator' }],
  });
  assert.equal(decision.action, 'open');
  assert.equal(decision.fleetType, 'company');
});

test('the same number in the SAME fleet is still contested', () => {
  const decision = decideUnitSync({
    personId: 1, currentUnit: null, targetUnit: '001', targetFleetType: 'company',
    holders: [{ personId: 4, seat: 1, fleetType: 'company' }],
  });
  assert.equal(decision.action, 'contested');
  assert.equal(decision.holderPersonId, 4);
});

test('unknown never wins a match — on either side', () => {
  // A holder we cannot place does not get waved aside, and a target we cannot
  // place does not get to walk past a holder.
  const unknownHolder = decideUnitSync({
    personId: 1, targetUnit: '001', targetFleetType: 'company',
    holders: [{ personId: 4, seat: 1, fleetType: 'unknown' }],
  });
  assert.equal(unknownHolder.action, 'contested');

  const unknownTarget = decideUnitSync({
    personId: 1, targetUnit: '001', targetFleetType: 'unknown',
    holders: [{ personId: 4, seat: 1, fleetType: 'company' }],
  });
  assert.equal(unknownTarget.action, 'contested');

  const bothUnknown = decideUnitSync({
    personId: 1, targetUnit: '001',
    holders: [{ personId: 4, seat: 1, fleetType: null }],
  });
  assert.equal(bothUnknown.action, 'contested');
});

test('a team takes the other seat rather than fighting for the first', () => {
  const decision = decideUnitSync({
    personId: 1, currentUnit: null, targetUnit: '008', targetFleetType: 'company',
    isTeam: true,
    holders: [{ personId: 4, seat: 1, fleetType: 'company' }],
  });
  assert.equal(decision.action, 'open');
  assert.equal(decision.seat, 2, 'a team is two people on one truck, not a duplicate');
});

test('a full team truck is contested — there is no third seat', () => {
  const decision = decideUnitSync({
    personId: 1, targetUnit: '008', targetFleetType: 'company', isTeam: true,
    holders: [
      { personId: 4, seat: 1, fleetType: 'company' },
      { personId: 5, seat: 2, fleetType: 'company' },
    ],
  });
  assert.equal(decision.action, 'contested');
  assert.equal(decision.holders.length, 2);
});

test('a team whose only holder is already in seat 2 does not double up', () => {
  const decision = decideUnitSync({
    personId: 1, targetUnit: '008', targetFleetType: 'company', isTeam: true,
    holders: [{ personId: 4, seat: 2, fleetType: 'company' }],
  });
  assert.equal(decision.action, 'contested',
    'seat 2 is taken and seat 1 is not offered by this rule — a person decides');
});

test('team only applies when the observation says team', () => {
  const decision = decideUnitSync({
    personId: 1, targetUnit: '008', targetFleetType: 'company', isTeam: false,
    holders: [{ personId: 4, seat: 1, fleetType: 'company' }],
  });
  assert.equal(decision.action, 'contested');
});

test('the older single-holder form still works, and is treated strictly', () => {
  // A caller that knows nothing about fleets gets the STRICT answer — every
  // holder contests — rather than a permissive one.
  const decision = decideUnitSync({
    personId: 1, currentUnit: '320', targetUnit: '001', holderPersonId: 4,
  });
  assert.equal(decision.action, 'contested');
  assert.equal(decision.holderPersonId, 4);
  assert.equal(decision.unitNumber, '001');
});

test('a fleet that reads differently on an UNCHANGED number is left alone', () => {
  // Retyping an assignment is its own decision with its own evidence. Doing it
  // inside a sync would move a driver between fleets on an edited chat title.
  const decision = decideUnitSync({
    personId: 1, currentUnit: '320', targetUnit: '320',
    currentFleetType: 'owner_operator', targetFleetType: 'company',
  });
  assert.deepEqual(decision, { action: 'noop', reason: 'unchanged' });
});
