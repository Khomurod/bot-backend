'use strict';

/**
 * The sweep reads only the chat members who could be a driver — and that
 * changes NO decision.
 *
 * October 2026: the whole of `group_members` (7,471 rows, nearly all of them
 * dispatchers and managers who sit in every driver chat) was read every 15
 * minutes, about 48 MB a day of database transfer. The read now returns only
 * accounts in fewer than STAFF_GROUP_COUNT active driver chats, which the
 * staff rule cannot exclude by count. This pins that the identity checks file
 * exactly the same findings from that as from the whole table.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { runTelegramIdentityChecks } = require('../services/operations/checks/telegramIdentity');
const { asTheLoaderReadsIt, fleet } = require('./helpers/telegramMembersModel');

function snapshotOf({ groups, groupMembers, botUsers }) {
  const names = {
    1: ['John', 'Smith'], 2: ['Alex', 'Kim'], 3: ['Peter', 'Pan'], 4: ['Pat', 'Jones'],
  };
  return {
    groups,
    groupMembers,
    botUsers,
    profiles: Object.entries(names).map(([groupId, [first, last]]) => ({
      group_id: Number(groupId), first_name: first, last_name: last,
    })),
    personGroups: [1, 2, 3, 4].map((groupId) => ({ group_id: groupId, person_id: 10 + groupId, ended_at: null })),
    linkedTelegramUserIds: new Set(),
    telegramIdentities: [],
  };
}

test('THE NARROWED READ FILES EXACTLY WHAT THE WHOLE TABLE DID', () => {
  const whole = fleet();
  const fromWhole = runTelegramIdentityChecks(snapshotOf(whole));
  const fromNarrowed = runTelegramIdentityChecks(snapshotOf({ ...whole, ...asTheLoaderReadsIt(whole) }));
  assert.ok(fromWhole.length >= 3, 'the fixture exercises a link, a question, and silence');
  assert.deepEqual(fromNarrowed, fromWhole);
});

test('…and it is a real narrowing: staff by count and members of other chats are not read', () => {
  const whole = fleet();
  const { groupMembers, botUsers } = asTheLoaderReadsIt(whole);
  const ids = [...new Set(groupMembers.map((m) => m.telegram_user_id))].sort();
  assert.deepEqual(ids, ['101', '202', '303', '505']);
  assert.ok(groupMembers.every((m) => [1, 2, 3, 4].includes(m.group_id)), 'active driver chats only');
  assert.deepEqual(botUsers.map((u) => u.telegram_user_id).sort(), ['404', '505', '900']);
});
