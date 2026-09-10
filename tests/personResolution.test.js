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
  assert.deepEqual(decideUnitSync({ personId: 1, currentUnit: '320', targetUnit: '322' }),
    { action: 'switch', from: '320', to: '322' });
  assert.deepEqual(decideUnitSync({ personId: 1, currentUnit: null, targetUnit: '322' }),
    { action: 'open', from: null, to: '322' });
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
