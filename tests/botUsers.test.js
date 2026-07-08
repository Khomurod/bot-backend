/**
 * Unit tests for database/botUsers.js — the bot_users capture + query helpers.
 *
 * The raw `pg` query is replaced with an in-memory fake that emulates just
 * enough Postgres upsert semantics (COALESCE keep-existing, counter increment,
 * conflict on the telegram_user_id primary key) to validate the module's
 * behavior without a live database. listBotUsers is exercised for its SQL/param
 * shaping (filters + search + the dispatch-team join).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadBotUsersWith(fakeQuery) {
  const modPath = path.resolve(__dirname, '../database/botUsers.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  delete require.cache[modPath];
  require.cache[dbPath] = { exports: { query: fakeQuery } };
  return require(modPath);
}

/** In-memory emulator for the bot_users upsert + dispatch backfill + list. */
function makeFakeDb() {
  const users = new Map(); // id -> row
  const selectCalls = [];
  const now = () => new Date().toISOString();

  async function query(sql, params) {
    const s = sql.replace(/\s+/g, ' ').trim();

    // recordBotUserSeen upsert (distinguished by message_count column).
    if (s.startsWith('INSERT INTO bot_users') && s.includes('message_count, last_group_id')) {
      const [id, username, first, last, lang, isBot, groupId, chatId, groupName] = params;
      const key = Number(id);
      const existing = users.get(key);
      if (!existing) {
        const row = {
          telegram_user_id: key, username, first_name: first, last_name: last,
          language_code: lang, is_bot: isBot, interactions: 0, message_count: 1,
          last_action: null, last_group_id: groupId, last_seen_chat_id: chatId,
          last_group_name: groupName, source: null,
          first_seen_at: now(), last_interaction_at: now(),
        };
        users.set(key, row);
        return { rows: [row], rowCount: 1 };
      }
      existing.username = username ?? existing.username;
      existing.first_name = first ?? existing.first_name;
      existing.last_name = last ?? existing.last_name;
      existing.language_code = lang ?? existing.language_code;
      existing.is_bot = isBot ?? existing.is_bot;
      existing.message_count += 1;
      existing.last_group_id = groupId ?? existing.last_group_id;
      existing.last_seen_chat_id = chatId ?? existing.last_seen_chat_id;
      existing.last_group_name = groupName ?? existing.last_group_name;
      existing.last_interaction_at = now();
      return { rows: [existing], rowCount: 1 };
    }

    if (s.startsWith('SELECT') && s.includes('FROM bot_users')) {
      selectCalls.push({ sql: s, params });
      return { rows: Array.from(users.values()), rowCount: users.size };
    }

    if (s.startsWith('UPDATE dispatch_team_members')) {
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unexpected SQL in fake: ${s.slice(0, 60)}`);
  }

  return { query, users, selectCalls };
}

test('recordBotUserSeen inserts a new user with message_count = 1', async () => {
  const fake = makeFakeDb();
  const db = loadBotUsersWith(fake.query);
  const row = await db.recordBotUserSeen({
    telegramUserId: 100, username: 'joe_d', firstName: 'Joe', lastName: 'Driver',
    languageCode: 'en', groupId: 7, chatId: -100123, groupName: 'Driver Joe',
  });
  assert.equal(row.telegram_user_id, 100);
  assert.equal(row.message_count, 1);
  assert.equal(row.username, 'joe_d');
  assert.equal(row.last_group_name, 'Driver Joe');
});

test('repeated messages increment message_count and refresh last seen (same id)', async () => {
  const fake = makeFakeDb();
  const db = loadBotUsersWith(fake.query);
  await db.recordBotUserSeen({ telegramUserId: 100, username: 'joe', groupName: 'G1' });
  await db.recordBotUserSeen({ telegramUserId: 100, username: 'joe', groupName: 'G2' });
  const row = await db.recordBotUserSeen({ telegramUserId: 100, username: 'joe', groupName: 'G3' });
  assert.equal(fake.users.size, 1);
  assert.equal(row.message_count, 3);
  assert.equal(row.last_group_name, 'G3');
});

test('a username change updates the SAME id row (no duplicate)', async () => {
  const fake = makeFakeDb();
  const db = loadBotUsersWith(fake.query);
  await db.recordBotUserSeen({ telegramUserId: 100, username: 'old_name', firstName: 'Joe' });
  const row = await db.recordBotUserSeen({ telegramUserId: 100, username: 'new_name', firstName: 'Joe' });
  assert.equal(fake.users.size, 1);
  assert.equal(row.username, 'new_name');
  assert.equal(row.message_count, 2);
});

test('a message with no username still stores the id and names', async () => {
  const fake = makeFakeDb();
  const db = loadBotUsersWith(fake.query);
  const row = await db.recordBotUserSeen({ telegramUserId: 55, firstName: 'Silent', lastName: 'Sam' });
  assert.equal(row.telegram_user_id, 55);
  assert.equal(row.username, null);
  assert.equal(row.first_name, 'Silent');
});

test('a later message keeps an existing username when the new update omits it (COALESCE)', async () => {
  const fake = makeFakeDb();
  const db = loadBotUsersWith(fake.query);
  await db.recordBotUserSeen({ telegramUserId: 100, username: 'joe' });
  const row = await db.recordBotUserSeen({ telegramUserId: 100 });
  assert.equal(row.username, 'joe');
});

test('recordBotUserSeen ignores a null telegramUserId', async () => {
  const fake = makeFakeDb();
  const db = loadBotUsersWith(fake.query);
  const row = await db.recordBotUserSeen({ telegramUserId: null, username: 'x' });
  assert.equal(row, null);
  assert.equal(fake.users.size, 0);
});

test('no message text is ever stored on a bot_users row', async () => {
  const fake = makeFakeDb();
  const db = loadBotUsersWith(fake.query);
  const row = await db.recordBotUserSeen({ telegramUserId: 100, username: 'joe' });
  const keys = Object.keys(row);
  assert.ok(!keys.some((k) => /text|message_body|body|content/.test(k)),
    `unexpected text-like column: ${keys.join(',')}`);
});

test('a bot user is recorded with is_bot true (rule: caller decides; storage is honest)', async () => {
  const fake = makeFakeDb();
  const db = loadBotUsersWith(fake.query);
  const row = await db.recordBotUserSeen({ telegramUserId: 999, username: 'somebot', isBot: true });
  assert.equal(row.is_bot, true);
});

test('listBotUsers builds a dispatch-team join and infers dispatch by username OR id', async () => {
  const fake = makeFakeDb();
  const db = loadBotUsersWith(fake.query);
  await db.recordBotUserSeen({ telegramUserId: 100, username: 'joe' });
  await db.listBotUsers({ filter: 'all' });
  const call = fake.selectCalls.at(-1);
  assert.match(call.sql, /LEFT JOIN LATERAL/i);
  assert.match(call.sql, /LOWER\(m\.telegram_username\) = LOWER\(u\.username\)/i);
  assert.match(call.sql, /m\.telegram_user_id = u\.telegram_user_id/i);
});

test('listBotUsers applies the dispatch filter and passes a search param', async () => {
  const fake = makeFakeDb();
  const db = loadBotUsersWith(fake.query);
  await db.recordBotUserSeen({ telegramUserId: 100, username: 'joe' });

  await db.listBotUsers({ filter: 'dispatch' });
  assert.match(fake.selectCalls.at(-1).sql, /dm\.id IS NOT NULL/);

  await db.listBotUsers({ filter: 'recent' });
  assert.match(fake.selectCalls.at(-1).sql, /INTERVAL '24 hours'/);

  await db.listBotUsers({ filter: 'all', search: 'Joe' });
  assert.ok(fake.selectCalls.at(-1).params.includes('%joe%'));
});

test('backfillDispatchMemberUserId only runs with both id and username', async () => {
  let ran = 0;
  const db = loadBotUsersWith(async (sql) => {
    if (sql.includes('UPDATE dispatch_team_members')) ran += 1;
    return { rows: [], rowCount: 1 };
  });
  assert.equal(await db.backfillDispatchMemberUserId({ telegramUserId: null, username: 'joe' }), 0);
  assert.equal(await db.backfillDispatchMemberUserId({ telegramUserId: 5, username: '' }), 0);
  assert.equal(ran, 0);
  const updated = await db.backfillDispatchMemberUserId({ telegramUserId: 5, username: 'joe' });
  assert.equal(updated, 1);
  assert.equal(ran, 1);
});
