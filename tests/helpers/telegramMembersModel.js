'use strict';

/**
 * What the sweep's member read returns, said in JavaScript — the model both
 * the decision-equivalence test and the PostgreSQL test hold the SQL to.
 *
 * Memberships of ACTIVE DRIVER chats only, of accounts in fewer than
 * STAFF_GROUP_COUNT of them, and the bot-user sources the staff rule reads.
 */
const { STAFF_GROUP_COUNT } = require('../../lib/identity/telegramResolution');

function asTheLoaderReadsIt({ groups, groupMembers, botUsers }) {
  const active = new Set(groups.filter((g) => g.group_type === 'driver' && g.active === true).map((g) => g.id));
  const inActive = groupMembers.filter((m) => active.has(m.group_id));
  const chats = new Map();
  for (const m of inActive) chats.set(String(m.telegram_user_id), (chats.get(String(m.telegram_user_id)) || 0) + 1);
  return {
    groupMembers: inActive.filter((m) => chats.get(String(m.telegram_user_id)) < STAFF_GROUP_COUNT),
    botUsers: botUsers.filter((u) => ['dispatcher', 'admin'].includes(String(u.source || '').toLowerCase())),
  };
}

/** Six chats, and every kind of account the rule tells apart. */
function fleet() {
  const groups = [1, 2, 3, 4].map((id) => ({ id, group_type: 'driver', active: true, group_name: `UNIT ${id}` }))
    .concat([
      { id: 5, group_type: 'driver', active: false, group_name: 'UNIT 5 (gone)' },
      { id: 6, group_type: 'company', active: true, group_name: 'Office' },
    ]);
  const member = (groupId, id, first, last) => ({
    group_id: groupId, telegram_user_id: String(id), username: null, first_name: first, last_name: last,
  });
  const groupMembers = [
    // A dispatcher in three driver chats: staff by count.
    member(1, 900, 'Dana', 'Dispatch'), member(2, 900, 'Dana', 'Dispatch'), member(3, 900, 'Dana', 'Dispatch'),
    // The driver of chat 1, in it alone.
    member(1, 101, 'John', 'Smith'),
    // In two driver chats, one gone chat and the office: two still count.
    member(1, 202, 'Alex', 'Kim'), member(2, 202, 'Alex', 'Kim'), member(5, 202, 'Alex', 'Kim'), member(6, 202, 'Alex', 'Kim'),
    // In one driver chat; the gone chat and the office do not count.
    member(4, 303, 'Maria', 'Lopez'), member(5, 303, 'Maria', 'Lopez'), member(6, 303, 'Maria', 'Lopez'),
    // Three driver chats: staff by count, whatever their source says.
    member(2, 404, 'Sam', 'Ops'), member(3, 404, 'Sam', 'Ops'), member(4, 404, 'Sam', 'Ops'),
    // One chat, but an admin by source.
    member(3, 505, 'Peter', 'Pan'),
  ];
  const botUsers = [
    { telegram_user_id: '900', source: 'Dispatcher' },
    { telegram_user_id: '101', source: 'driver' },
    { telegram_user_id: '202', source: null },
    { telegram_user_id: '404', source: 'admin' },
    { telegram_user_id: '505', source: 'admin' },
  ];
  return { groups, groupMembers, botUsers };
}

module.exports = { asTheLoaderReadsIt, fleet };
