'use strict';

/**
 * What ONE ordinary driver message costs the database.
 *
 * October 2026: the hosted database's monthly transfer allowance was nearly
 * spent, and a driver's message measured about 5.7 KB of reads — roughly ten
 * statements, several returning or selecting whole rows that nothing used:
 * the group row twice, the sender's three identity rows echoed back, a 46-column
 * description of `home_time_requests` for a lookup that can no longer find
 * anything, and the person link the resolver had just confirmed. At about ten
 * thousand messages a day that was ~50 MB a day on its own.
 *
 * The whole real pipeline runs here — the registration middleware and the
 * group message handler — against a fake `pg` that records every statement.
 * The first message is the cold path; the SECOND message from the same person
 * in the same chat is what nearly every message looks like, and that is the
 * one held to a budget.
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const sent = [];
const GROUP_ROW = {
  id: 7, telegram_group_id: '-1001000000007', group_name: 'WENZE UNIT # 7 TEST DRIVER',
  group_type: 'driver', active: true, status_source: 'bot', language: 'en',
};

function respond(text) {
  if (/INSERT INTO groups|FROM groups WHERE telegram_group_id/.test(text)) {
    return { rows: [{ ...GROUP_ROW }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

const textOf = (q) => (typeof q === 'string' ? q : q?.text || '');
class FakeClient {
  async query(q) { sent.push(textOf(q)); return respond(textOf(q)); }
  release() {}
}
class FakePool {
  on() {}
  async query(q) { sent.push(textOf(q)); return respond(textOf(q)); }
  async connect() { return new FakeClient(); }
}
require.cache[require.resolve('pg')] = { exports: { Pool: FakePool } };

// eslint-disable-next-line global-require
const { registerGroupCaptureHandlers, resetCaptureMemory } = require('../bot/handlers/groupCaptureHandlers');
const { forgetGroupRows } = require('../database/groupRowCache');
const db = require('../database/db');
const { resetResolverCache } = require('../services/identity/personResolver');

function freshProcess() {
  resetCaptureMemory();
  forgetGroupRows();
  resetResolverCache();
  sent.length = 0;
}

function fakeBot() {
  const chain = [];
  return {
    chain,
    telegram: { async setMessageReaction() {}, async sendMessage() { return { message_id: 1 }; } },
    use(fn) { chain.push(fn); },
    on(event, fn) { chain.push((ctx, next) => (event === 'message' && ctx.message ? fn(ctx, next) : next())); },
  };
}

async function deliver(bot, text, messageId, fromOverride = {}) {
  const from = {
    id: 5550001, is_bot: false, first_name: 'TEST', last_name: 'DRIVER', username: 'test_driver_7', ...fromOverride,
  };
  const chat = { id: -1001000000007, type: 'supergroup', title: 'WENZE UNIT # 7 TEST DRIVER' };
  const message = { message_id: messageId, date: Math.floor(Date.now() / 1000), text, from, chat };
  const ctx = { chat, from, message, update: { message }, telegram: bot.telegram };
  let i = 0;
  const next = async () => { const fn = bot.chain[i++]; if (fn) await fn(ctx, next); };
  await next();
  // The pipeline detaches several writes; let them land before counting.
  for (let k = 0; k < 5; k += 1) await new Promise((r) => setImmediate(r));
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
const WHOLE_ROW = /RETURNING \*|SELECT \*|SELECT [a-z_]+\.\*/i;

test('A REPEATED DRIVER MESSAGE reads no whole rows and stays within its statement budget', async () => {
  freshProcess();
  const bot = fakeBot();
  registerGroupCaptureHandlers(bot);

  await deliver(bot, 'ok thanks, will call later', 1);
  sent.length = 0;
  await deliver(bot, 'on my way to the shipper', 2);
  const statements = sent.map(oneLine);
  const listing = statements.map((s) => `  ${s.slice(0, 110)}`).join('\n');

  const wholeRow = statements.filter((s) => WHOLE_ROW.test(s));
  assert.deepEqual(wholeRow.map((s) => s.slice(0, 110)), [], `whole-row reads on the hot path:\n${listing}`);
  // `bot_users` counts messages, so it is written every time — without reading
  // the row back. In production the chat-capture insert is the other one.
  assert.ok(statements.length <= 2, `a repeated message sent ${statements.length} statements:\n${listing}`);
});

const wrote = (table) => sent.some((q) => new RegExp(`INSERT INTO ${table}\\b`).test(q));

test('A CHANGED NAME is written on the very next message — only unchanged writes are skipped', async () => {
  freshProcess();
  const bot = fakeBot();
  registerGroupCaptureHandlers(bot);
  await deliver(bot, 'hello', 1);
  sent.length = 0;
  await deliver(bot, 'hello again', 2, { username: 'renamed_driver_7' });
  assert.ok(wrote('drivers'), 'the new username reaches `drivers`');
  assert.ok(wrote('group_members'), 'and the membership row');
});

test('A GROUP CHANGED THROUGH THE APP is read fresh on the next message, not from the cache', async () => {
  freshProcess();
  const bot = fakeBot();
  registerGroupCaptureHandlers(bot);
  await deliver(bot, 'hello', 1);
  await db.setGroupLanguage(GROUP_ROW.id, 'uz');
  sent.length = 0;
  await deliver(bot, 'hello again', 2);
  assert.ok(sent.some((q) => /INSERT INTO groups/.test(q)), 'the row is fetched again after a write');
});

test('A WRITE THAT FAILED is tried again on the next message', async (t) => {
  freshProcess();
  const bot = fakeBot();
  registerGroupCaptureHandlers(bot);
  const original = FakePool.prototype.query;
  let failDrivers = true;
  FakePool.prototype.query = async function failing(q) {
    if (failDrivers && /INSERT INTO drivers/.test(textOf(q))) { sent.push(textOf(q)); throw new Error('connection reset'); }
    return original.call(this, q);
  };
  t.after(() => { FakePool.prototype.query = original; });
  await deliver(bot, 'hello', 1);
  failDrivers = false;
  sent.length = 0;
  await deliver(bot, 'hello again', 2);
  assert.ok(wrote('drivers'), 'the failed write is not remembered as done');
});
