'use strict';

/**
 * Turning a room full of people into one finding, and which tier it lands in.
 *
 * A driver chat contains the driver, their dispatcher, a manager and whoever
 * was added once. Only `identity.telegram_link` is `auto`, and only when the
 * room narrows to one plausible person whose name agrees.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { runTelegramIdentityChecks, CHECK_KEYS } = require('../services/operations/checks/telegramIdentity');
const { CHECKS } = require('../lib/identity/telegramResolution');

function snapshot(over = {}) {
  return {
    groups: [{ id: 1, group_name: 'WENZE UNIT # 27 JOHN SMITH', group_type: 'driver', active: true }],
    profiles: [{ group_id: 1, first_name: 'JOHN', last_name: 'SMITH' }],
    personGroups: [{ group_id: 1, person_id: 10, ended_at: null }],
    groupMembers: [],
    botUsers: [],
    telegramIdentities: [],
    linkedTelegramUserIds: new Set(),
    ...over,
  };
}

const DRIVER = { group_id: 1, telegram_user_id: 501, first_name: 'JOHN', last_name: 'SMITH' };

test('one matching person in the chat is the only auto-tier finding', () => {
  const [found] = runTelegramIdentityChecks(snapshot({ groupMembers: [DRIVER] }));
  assert.equal(found.checkKey, 'identity.telegram_link');
  assert.equal(found.tier, 'auto');
  assert.deepEqual(found.proposedChange, { personId: 10, groupId: 1, telegramUserId: '501' });
});

test('A TELEGRAM ID NEVER APPEARS IN A FINDING TITLE', () => {
  // Titles are published to notices. An account id in a headline would reach a
  // group chat's permanent history.
  const [found] = runTelegramIdentityChecks(snapshot({ groupMembers: [DRIVER] }));
  assert.ok(!found.title.includes('501'), found.title);
  assert.ok(!JSON.stringify(found.evidence).includes('501'), 'nor in the evidence');
});

test('a name that does not agree needs a person, and proposes nothing', () => {
  const [found] = runTelegramIdentityChecks(snapshot({
    groupMembers: [{ ...DRIVER, first_name: 'Ivan', last_name: 'Petrov' }],
  }));
  assert.equal(found.checkKey, CHECKS.UNNAMED);
  assert.equal(found.tier, 'approval');
  assert.equal(found.proposedChange, null);
});

test('several candidates is a warning with nothing proposed', () => {
  const [found] = runTelegramIdentityChecks(snapshot({
    groupMembers: [DRIVER, { group_id: 1, telegram_user_id: 502, first_name: 'ANN', last_name: 'LEE' }],
  }));
  assert.equal(found.checkKey, CHECKS.AMBIGUOUS);
  assert.equal(found.tier, 'warning');
  assert.equal(found.proposedChange, null);
  assert.equal(found.evidence.candidates, 2);
});

test('A DISPATCHER IN EVERY CHAT NEVER BECOMES "THE ONE CANDIDATE"', () => {
  const found = runTelegramIdentityChecks(snapshot({
    groupMembers: [{ ...DRIVER, first_name: 'Ann', last_name: 'Dispatch' }],
    botUsers: [{ telegram_user_id: 501, source: 'dispatcher' }],
  }));
  assert.deepEqual(found, []);
});

test('AN UNLABELLED MANAGER IS CAUGHT BY THE CHATS THEY ARE IN', () => {
  // Three driver chats. A driver is in one. Nothing labelled this account.
  const groups = [1, 2, 3].map((id) => ({
    id, group_name: `WENZE UNIT # ${id}`, group_type: 'driver', active: true,
  }));
  const found = runTelegramIdentityChecks(snapshot({
    groups,
    profiles: groups.map((g) => ({ group_id: g.id, first_name: 'JOHN', last_name: 'SMITH' })),
    personGroups: groups.map((g) => ({ group_id: g.id, person_id: 10 + g.id, ended_at: null })),
    groupMembers: groups.map((g) => ({ ...DRIVER, group_id: g.id })),
  }));
  assert.deepEqual(found, [], 'in three driver chats, so not a driver');
});

test('AN ACCOUNT ALREADY LINKED IS NOT PROPOSED AGAIN', () => {
  const found = runTelegramIdentityChecks(snapshot({
    groupMembers: [DRIVER],
    linkedTelegramUserIds: new Set(['501']),
  }));
  assert.deepEqual(found, []);
});

test('a person who already has an account is left alone', () => {
  const found = runTelegramIdentityChecks(snapshot({
    groupMembers: [DRIVER],
    telegramIdentities: [{ person_id: 10, telegram_user_id: 999, ended_at: null }],
  }));
  assert.deepEqual(found, []);
});

test('a closed link does not count as having an account', () => {
  const [found] = runTelegramIdentityChecks(snapshot({
    groupMembers: [DRIVER],
    telegramIdentities: [{ person_id: 10, telegram_user_id: 999, ended_at: '2026-01-01' }],
  }));
  assert.equal(found.checkKey, 'identity.telegram_link');
});

test('A TEAM CHAT IS NEVER RESOLVED AUTOMATICALLY', () => {
  const [found] = runTelegramIdentityChecks(snapshot({
    profiles: [{
      group_id: 1, first_name: 'JOHN', last_name: 'SMITH',
      secondary_first_name: 'MARIA', secondary_last_name: 'GARCIA',
    }],
    groupMembers: [DRIVER],
  }));
  assert.equal(found.checkKey, CHECKS.AMBIGUOUS);
});

test('a chat with no person behind it has nobody to attribute an account to', () => {
  const found = runTelegramIdentityChecks(snapshot({
    personGroups: [], groupMembers: [DRIVER],
  }));
  assert.deepEqual(found, []);
});

test('an inactive or non-driver chat is not examined', () => {
  for (const over of [{ active: false }, { group_type: 'company' }]) {
    const found = runTelegramIdentityChecks(snapshot({
      groups: [{ id: 1, group_name: 'x', group_type: 'driver', active: true, ...over }],
      groupMembers: [DRIVER],
    }));
    assert.deepEqual(found, [], JSON.stringify(over));
  }
});

test('no members at all, and a missing member list, are both silence', () => {
  assert.deepEqual(runTelegramIdentityChecks(snapshot()), []);
  assert.deepEqual(runTelegramIdentityChecks(snapshot({ groupMembers: null })), []);
});

test('every key this module emits is declared', () => {
  const emitted = new Set();
  const scenarios = [
    snapshot({ groupMembers: [DRIVER] }),
    snapshot({ groupMembers: [{ ...DRIVER, first_name: 'Ivan', last_name: 'Petrov' }] }),
    snapshot({ groupMembers: [DRIVER, { group_id: 1, telegram_user_id: 502, first_name: 'A', last_name: 'B' }] }),
  ];
  for (const s of scenarios) for (const f of runTelegramIdentityChecks(s)) emitted.add(f.checkKey);
  for (const key of emitted) assert.ok(CHECK_KEYS.includes(key), `${key} is not in CHECK_KEYS`);
  assert.equal(emitted.size, 3, 'all three shapes were exercised');
});
