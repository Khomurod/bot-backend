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

// Only the profile-save test sets this, so the message pipeline never sees a
// driver profile it would not have in the other tests.
let PROFILE_ROW = null;

function respond(text, values) {
  if (/INSERT INTO groups|FROM groups WHERE telegram_group_id/.test(text)) {
    return { rows: [{ ...GROUP_ROW }], rowCount: 1 };
  }
  if (PROFILE_ROW && /INSERT INTO driver_profiles/.test(text)) {
    // The upsert returns the row it saved: `language` and `date_of_birth` are
    // its 15th and 16th parameters.
    return { rows: [{ ...PROFILE_ROW, language: values[14], date_of_birth: values[15] }], rowCount: 1 };
  }
  if (PROFILE_ROW && /FROM driver_profiles dp/.test(text)) {
    return { rows: [{ ...PROFILE_ROW }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

const textOf = (q) => (typeof q === 'string' ? q : q?.text || '');
const valuesOf = (q, values) => (Array.isArray(values) ? values : (q?.values || []));
/** Statements WITH their parameters, for the one test that checks a value. */
const calls = [];
function record(q, values) {
  const text = textOf(q);
  const params = valuesOf(q, values);
  sent.push(text);
  calls.push({ text, params });
  return respond(text, params);
}
class FakeClient {
  async query(q, values) { return record(q, values); }
  release() {}
}
class FakePool {
  on() {}
  async query(q, values) { return record(q, values); }
  async connect() { return new FakeClient(); }
}
require.cache[require.resolve('pg')] = { exports: { Pool: FakePool } };

// eslint-disable-next-line global-require
const { registerGroupCaptureHandlers, resetCaptureMemory } = require('../bot/handlers/groupCaptureHandlers');
const { forgetGroupRows } = require('../database/groupRowCache');
const db = require('../database/db');
const { resetResolverCache } = require('../services/identity/personResolver');

function freshProcess() {
  PROFILE_ROW = null;
  resetCaptureMemory();
  forgetGroupRows();
  resetResolverCache();
  sent.length = 0;
  calls.length = 0;
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
  // An administrator changes the driver's language on their profile: the save
  // Settings → Driver Profiles makes, which writes the group's own columns too.
  // Cleared first: the message above wrote `groups` too (its last-seen time).
  sent.length = 0;
  calls.length = 0;
  PROFILE_ROW = {
    id: 70, group_id: GROUP_ROW.id, language: 'en', date_of_birth: '1990-04-01', status: 'active',
  };
  const saved = await db.updateDriverProfile(70, { language: 'uz' });
  assert.ok(saved, 'the fake database holds the profile, so the save ran');
  const groupSync = () => calls.find((c) => /UPDATE groups\s+SET language = \$1/.test(c.text));
  const sync = groupSync();
  assert.ok(sync, 'the save wrote the group\'s own columns');
  assert.equal(sync.params[0], 'uz', 'with the language the administrator chose');
  // The birthday rides the same write (the birthday cards read the group's
  // copy), and clearing it on the profile clears the group's too.
  assert.equal(sync.params[1], '1990-04-01', 'and the birthday the profile holds');
  calls.length = 0;
  await db.updateDriverProfile(70, { date_of_birth: null });
  assert.equal(groupSync()?.params[1], null, 'a cleared birthday is cleared on the group');
  PROFILE_ROW = null; // the next message meets the same database as every other test
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
