/**
 * Multi-trailer bot handling (services/trailerMonitorService). One Telegram
 * message that names two trailers must create two events (event_index 0/1),
 * reply ONCE with a summary, and react ONCE. The db module + AI classifier are
 * faked; no live DB or network.
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

function loadMonitor() {
  const modPath = path.resolve(__dirname, '../services/trailerMonitorService.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const classifierPath = path.resolve(__dirname, '../services/trailerClassifier.js');
  const geoPath = path.resolve(__dirname, '../services/trailerGeocodeService.js');

  const state = { events: [], statusUpdates: [] };
  const fakeDb = {
    getTrailerSettings: async () => ({
      enabled: true, beta_mode: true, automatic_update_test_group_id: null,
      send_driver_group_confirmation: true, send_reaction: true,
      ai_fallback_enabled: true, geocoding_enabled: false,
    }),
    getDriverProfileByGroupId: async () => ({ id: 5, first_name: 'John', last_name: 'Driver' }),
    ensureTrailerForDetection: async (unit) => ({ id: 100 + state.events.length, unit_number: unit }),
    getTrailerByUnitNumber: async (unit) => (unit ? { id: 100, unit_number: unit } : null),
    insertTrailerEvent: async (input) => {
      // Dedupe by (group, message, event_index), mirroring the real unique index.
      const key = `${input.telegram_group_id}:${input.telegram_message_id}:${input.event_index || 0}`;
      if (state.events.some((e) => e._key === key)) return { event: null, duplicate: true };
      const event = { id: state.events.length + 1, _key: key, ...input };
      state.events.push(event);
      return { event, duplicate: false };
    },
    applyEventToCurrentStatus: async (trailer, event) => { state.statusUpdates.push({ trailer, event }); return {}; },
  };

  delete require.cache[modPath];
  require.cache[dbPath] = { exports: fakeDb };
  require.cache[classifierPath] = { exports: { classifyTrailerMessageWithAi: async () => null, isAiConfigured: () => false } };
  // Geocoding disabled in settings, but stub anyway so nothing can hit network.
  require.cache[geoPath] = { exports: { geocodeTrailerLocation: async () => ({ lat: null, lng: null, source: 'text_only', confidence: 0 }) } };
  return { mod: require(modPath), state };
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
const msg = (text, extra = {}) => ({ message_id: 42, date: Math.floor(Date.now() / 1000), from: { id: 777, username: 'reporter', first_name: 'Rep' }, text, ...extra });

test('single-trailer message creates exactly one event (contract preserved)', async () => {
  const { mod, state } = loadMonitor();
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('trl # ST508998 picked up\nLocation: Reno NV'));
  assert.equal(res.registered, true);
  assert.equal(res.registeredCount, 1);
  assert.equal(state.events.length, 1);
});

test('two-trailer message creates two events with distinct event_index', async () => {
  const { mod, state } = loadMonitor();
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('TRL# 403279 picked up\nTRL# 171847 dropped'));
  assert.equal(res.registered, true);
  assert.equal(res.registeredCount, 2);
  assert.equal(state.events.length, 2);
  assert.deepEqual(state.events.map((e) => e.event_index), [0, 1]);
  assert.deepEqual(state.events.map((e) => e.event_type), ['pickup', 'dropoff']);
  assert.equal(state.statusUpdates.length, 2);
});

test('multi-trailer message replies ONCE (summary) and reacts ONCE', async () => {
  const { mod } = loadMonitor();
  const tg = makeTelegram();
  await mod.handleTrailerGroupMessage(tg, GROUP, msg('TRL# 403279 picked up\nTRL# 171847 dropped'));
  const replies = tg.sent.filter((m) => String(m.chatId) === String(GROUP.telegram_group_id));
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /403279 — pickup/);
  assert.match(replies[0].text, /171847 — drop-off/);
  assert.equal(tg.reactions.length, 1);
});

test('resending the same multi-trailer message creates no duplicate events', async () => {
  const { mod, state } = loadMonitor();
  const tg = makeTelegram();
  await mod.handleTrailerGroupMessage(tg, GROUP, msg('TRL# 403279 picked up\nTRL# 171847 dropped'));
  const res2 = await mod.handleTrailerGroupMessage(tg, GROUP, msg('TRL# 403279 picked up\nTRL# 171847 dropped'));
  assert.equal(state.events.length, 2); // still 2, not 4
  assert.equal(res2.skipped, 'duplicate');
});
