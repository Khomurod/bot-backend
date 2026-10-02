/**
 * The bot follows a group's move BEFORE it registers the group.
 *
 * `migrate_from_chat_id` arrives in the NEW supergroup. The registration
 * middleware upserts `ctx.chat.id`, so if it ran first the new id would get a
 * `groups` row of its own; the move would then find the new id taken and leave
 * every relationship on the obsolete row — one Telegram group split in two.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const HANDLERS = path.resolve(__dirname, '../bot/handlers/groupCaptureHandlers.js');
const DB = path.resolve(__dirname, '../database/db.js');
const MIGRATION = path.resolve(__dirname, '../services/telegramChatMigration.js');
const SEND = path.resolve(__dirname, '../services/notifications/send.js');
const RESOLVER = path.resolve(__dirname, '../services/identity/personResolver.js');

function loadWithStubs(order) {
  for (const p of [HANDLERS, DB, MIGRATION, SEND, RESOLVER]) delete require.cache[p];
  require.cache[DB] = {
    id: DB, filename: DB, loaded: true,
    exports: new Proxy({
      async upsertGroup(id) { order.push(`upsert ${id}`); return { id: 1, group_type: 'company', active: true }; },
    }, { get: (t, k) => (k in t ? t[k] : async () => null) }),
  };
  require.cache[MIGRATION] = {
    id: MIGRATION, filename: MIGRATION, loaded: true,
    exports: {
      async followMigration(from, to) { order.push(`follow ${from}->${to}`); return { nothingToDo: true }; },
      migrationNotice: () => null,
    },
  };
  require.cache[SEND] = { id: SEND, filename: SEND, loaded: true, exports: { async notify() {} } };
  require.cache[RESOLVER] = { id: RESOLVER, filename: RESOLVER, loaded: true, exports: { async ensurePersonForGroup() {} } };
  return require(HANDLERS);
}

function fakeBot() {
  const chain = [];
  return {
    chain,
    use(fn) { chain.push(fn); },
    on(event, fn) { chain.push((ctx, next) => (event === 'message' && ctx.message ? fn(ctx, next) : next())); },
  };
}

async function run(chain, ctx) {
  let i = 0;
  const next = async () => { const fn = chain[i++]; if (fn) await fn(ctx, next); };
  await next();
}

for (const [label, ctx, expected] of [
  ['the NEW chat\'s "migrated from" message', {
    chat: { id: -1001234567890, type: 'supergroup', title: 'HR Personnel' },
    message: { message_id: 1, migrate_from_chat_id: -5052301861 },
  }, ['follow -5052301861->-1001234567890', 'upsert -1001234567890']],
  ['the OLD chat\'s "migrated to" message', {
    chat: { id: -5052301861, type: 'group', title: 'HR Personnel' },
    message: { message_id: 1, migrate_to_chat_id: -1001234567890 },
  }, ['follow -5052301861->-1001234567890', 'upsert -5052301861']],
]) {
  test(`${label}: the move is followed first, then the chat is registered`, async () => {
    const order = [];
    const { registerGroupCaptureHandlers } = loadWithStubs(order);
    const bot = fakeBot();
    registerGroupCaptureHandlers(bot);
    await run(bot.chain, { ...ctx, from: { id: 5, is_bot: false, first_name: 'A' }, update: { message: ctx.message } });
    const relevant = order.filter((o) => o.startsWith('follow') || o.startsWith('upsert'));
    assert.deepEqual(relevant.slice(0, 2), expected);
  });
}
