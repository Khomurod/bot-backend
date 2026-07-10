/**
 * Unit tests for services/trailerMonitorService.js — the Telegram trailer
 * monitor. The db module and the AI classifier are replaced with fakes; a fake
 * `telegram` records sendMessage / setMessageReaction so behavior is asserted
 * without a live DB or network.
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test-key';
process.env.TRAILER_TEST_GROUP_ID ||= '-100999';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadMonitor({ dbOverrides = {}, aiResult = null } = {}) {
  const modPath = path.resolve(__dirname, '../services/trailerMonitorService.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const classifierPath = path.resolve(__dirname, '../services/trailerClassifier.js');

  const state = { events: [], statusUpdates: [], queries: [] };
  const fakeDb = {
    getTrailerSettings: async () => ({
      enabled: true, beta_mode: true, automatic_update_test_group_id: null,
      send_driver_group_confirmation: true, send_reaction: true,
      ai_fallback_enabled: true, geocoding_enabled: false,
    }),
    getDriverProfileByGroupId: async () => ({ id: 5, first_name: 'John', last_name: 'Driver' }),
    ensureTrailerForDetection: async (unit) => ({ id: 100, unit_number: unit }),
    getTrailerByUnitNumber: async (unit) => (unit ? { id: 100, unit_number: unit } : null),
    insertTrailerEvent: async (input) => {
      if (dbOverrides.forceDuplicate) return { event: { id: 1, ...input }, duplicate: true };
      const event = { id: state.events.length + 1, ...input };
      state.events.push(event);
      return { event, duplicate: false };
    },
    applyEventToCurrentStatus: async (trailer, event) => { state.statusUpdates.push({ trailer, event }); return {}; },
    query: async (sql, params) => { state.queries.push({ sql, params }); return { rows: [], rowCount: 0 }; },
    ...dbOverrides.db,
  };

  delete require.cache[modPath];
  require.cache[dbPath] = { exports: fakeDb };
  require.cache[classifierPath] = { exports: { classifyTrailerMessageWithAi: async () => aiResult, isAiConfigured: () => false } };
  const mod = require(modPath);
  return { mod, state };
}

function makeTelegram() {
  const sent = [];
  const reactions = [];
  return {
    sent, reactions,
    sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return { message_id: 999 }; },
    setMessageReaction: async (chatId, messageId, reaction) => { reactions.push({ chatId, messageId, reaction }); },
  };
}

const GROUP = { id: 1, telegram_group_id: -100123, group_name: 'Driver 55', group_type: 'driver', active: true };

function msg(text, extra = {}) {
  return { message_id: 42, date: Math.floor(Date.now() / 1000), from: { id: 777, username: 'reporter', first_name: 'Rep' }, text, ...extra };
}

test('pickup registers event, replies to driver group, reacts 👍', async () => {
  const { mod, state } = loadMonitor();
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg(
    'trl # VT700669\nPicked up by: ENICSON JEAN\nLocation: Lancaster PA\nCondition: no pictures'
  ));
  assert.equal(res.registered, true);
  assert.equal(res.eventType, 'pickup');
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].event_type, 'pickup');
  assert.equal(state.events[0].condition_text, 'no pictures');
  assert.equal(state.statusUpdates.length, 1); // current status updated
  // Reply to the ORIGINAL message, labeled Beta.
  const reply = tg.sent.find((m) => String(m.chatId) === String(GROUP.telegram_group_id));
  assert.ok(reply);
  assert.match(reply.text, /pickup registered/i);
  assert.match(reply.text, /Beta test mode/i);
  assert.equal(reply.opts.reply_to_message_id, 42);
  assert.equal(tg.reactions.length, 1);
});

test('dropoff registers event and updates status', async () => {
  const { mod, state } = loadMonitor();
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg(
    'trl # ST508998\nDropped by: ENICSON JEAN\nLocation: Lancaster PA\nCondition: no pictures'
  ));
  assert.equal(res.eventType, 'dropoff');
  assert.equal(state.events[0].event_type, 'dropoff');
  assert.equal(state.statusUpdates.length, 1);
});

test('unidentified "trailer?" does NOT reply to driver group; reports to test group', async () => {
  const { mod, state } = loadMonitor();
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('trailer?'));
  assert.equal(res.unidentified, true);
  // No confirmation to the driver group.
  assert.ok(!tg.sent.some((m) => String(m.chatId) === String(GROUP.telegram_group_id)));
});

test('unidentified WITH a unit but no action reports to the test group', async () => {
  const { mod } = loadMonitor();
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('trailer ST508998 where is it'));
  assert.equal(res.reportedToTest, true);
  const report = tg.sent.find((m) => String(m.chatId) === '-100999');
  assert.ok(report, 'test-group report sent');
  assert.match(report.text, /Unidentified trailer command/i);
});

test('duplicate Telegram message does not double-register or re-reply', async () => {
  const { mod, state } = loadMonitor({ dbOverrides: { forceDuplicate: true } });
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('trl # VT700669 picked up\nLocation: Reno NV'));
  assert.equal(res.skipped, 'duplicate');
  assert.equal(tg.sent.length, 0);
  assert.equal(tg.reactions.length, 0);
});

test('bot own messages are ignored', async () => {
  const { mod } = loadMonitor();
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('trl # VT700669 picked up', { from: { id: 1, is_bot: true } }));
  assert.equal(res.skipped, 'from-bot');
});

test('non-trailer messages are skipped cheaply', async () => {
  const { mod } = loadMonitor();
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('running late, be there in 2 hours'));
  assert.equal(res.skipped, 'not-trailer');
});

test('photo with caption is processed as a pickup', async () => {
  const { mod, state } = loadMonitor();
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, {
    message_id: 43, date: Math.floor(Date.now() / 1000), from: { id: 777, username: 'rep' },
    caption: 'trl # AB123 picked up\nLocation: Dallas TX',
    photo: [{ file_id: 'small' }, { file_id: 'big' }],
  });
  assert.equal(res.eventType, 'pickup');
  assert.ok(state.events[0].evidence);
  assert.deepEqual(state.events[0].evidence.photo_file_ids, ['big']);
});

test('feature disabled → no processing', async () => {
  const { mod } = loadMonitor({ dbOverrides: { db: { getTrailerSettings: async () => ({ enabled: false }) } } });
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('trl # VT700669 picked up'));
  assert.equal(res.skipped, 'disabled');
});
