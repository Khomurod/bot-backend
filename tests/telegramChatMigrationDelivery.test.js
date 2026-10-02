/**
 * The delivery paths, when the group they send to has moved.
 *
 * Production, 2026-10-02: every home-time notice to the managers failed with
 * "group chat was upgraded to a supergroup chat" — six attempts each, then
 * stopped. The new id was in every one of those errors.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { upgradedError } = require('./helpers/telegramErrors');
const { migrationTargetFrom } = require('../lib/telegram/chatMigration');

const NOTICES_PATH = path.resolve(__dirname, '../services/homeTime/managerNotices.js');
const HT_PATH = path.resolve(__dirname, '../database/homeTime.js');
const HTML_PATH = path.resolve(__dirname, '../services/telegramHtml.js');

const OLD = '-5052301861';
const NEW = '-1001234567890';

function loadManagerNotices() {
  for (const p of [NOTICES_PATH, HT_PATH, HTML_PATH]) delete require.cache[p];
  const state = { delivered: [], failed: [] };
  require.cache[HT_PATH] = {
    exports: {
      async markNoticeDelivered(id, opts) { state.delivered.push({ id, ...opts }); },
      async markNoticeFailed(id, err) { state.failed.push({ id, err }); },
    },
  };
  require.cache[HTML_PATH] = { exports: { async safeSend(fn) { return fn(); } } };
  return { mod: require(NOTICES_PATH), state };
}

function fakeMigration() {
  const calls = [];
  return {
    calls,
    async followMigrationFromError(err, oldId) {
      const to = migrationTargetFrom(err);
      if (!to) return null;
      calls.push([oldId, to]);
      return { newChatId: to, summary: { from: oldId, to, changed: [{ rows: 1 }], requeued: 2, nothingToDo: false } };
    },
    migrationNotice: (summary) => ({ category: 'self_healing', title: 'moved', summary }),
  };
}

function telegramThatMoved() {
  const sends = [];
  return {
    sends,
    async sendMessage(chatId, text) {
      sends.push(String(chatId));
      if (String(chatId) === OLD) throw upgradedError(Number(NEW));
      return { message_id: 900 };
    },
  };
}

test('a notice to a moved group is delivered to the new id, and the move is announced once', async () => {
  const { mod, state } = loadManagerNotices();
  const telegram = telegramThatMoved();
  const migration = fakeMigration();
  const said = [];
  const ok = await mod.deliverOne(telegram, { id: 41, chatId: OLD, body: 'Driver Is Home' }, {
    migration, notify: async (n) => { said.push(n); },
  });
  assert.equal(ok, true);
  assert.deepEqual(telegram.sends, [OLD, NEW], 'tried the old id, then sent to the new one');
  assert.deepEqual(migration.calls, [[OLD, NEW]], 'the move was applied from the error');
  assert.deepEqual(state.delivered, [{ id: 41, telegramMessageId: 900 }]);
  assert.equal(state.failed.length, 0);
  await new Promise((r) => setImmediate(r));
  assert.equal(said.length, 1);
  assert.equal(said[0].category, 'self_healing');
});

test('any other failure is still a failure — nothing is moved', async () => {
  const { mod, state } = loadManagerNotices();
  const migration = fakeMigration();
  const telegram = { async sendMessage() { throw new Error('400: Bad Request: chat not found'); } };
  const ok = await mod.deliverOne(telegram, { id: 42, chatId: OLD, body: 'x' }, { migration, notify: async () => {} });
  assert.equal(ok, false);
  assert.equal(migration.calls.length, 0);
  assert.match(state.failed[0].err, /chat not found/);
});

test('the operations notices follow a moved group too', async () => {
  const { deliverOne } = require('../services/notifications/send');
  const telegram = telegramThatMoved();
  const migration = fakeMigration();
  const settled = { delivered: [], failed: [] };
  const ok = await deliverOne({ id: 7, chatId: OLD, body: 'ops', replyToMessageId: 55 }, {
    telegram,
    safeSend: (fn) => fn(),
    migration,
    store: {
      async markNotificationDelivered(id, o) { settled.delivered.push({ id, ...o }); },
      async markNotificationFailed(id, e) { settled.failed.push({ id, e }); },
    },
    // notify() for the announcement: it stops at an unknown setting, which is
    // enough here — the delivery is what is under test.
    settings: { async getNotificationSettings() { return { enabled: false }; } },
  });
  assert.equal(ok, true);
  assert.deepEqual(telegram.sends, [OLD, NEW]);
  assert.deepEqual(settled.delivered, [{ id: 7, telegramMessageId: 900 }]);
});
