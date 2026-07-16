/**
 * Multi-trailer bot handling (services/trailerMonitorService). One Telegram
 * message that names two trailers must create two events (event_index 0/1),
 * reply ONCE with a summary, and react ONCE — after the (mocked) AI semantic
 * verifier confirms each event independently and the REAL hard gate passes.
 * The db module, vision, and verifier AI call are faked; no live DB or network.
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

const monitorPath = path.resolve(__dirname, '../services/trailerMonitorService.js');
const contextPath = path.resolve(__dirname, '../services/trailerContextService.js');
const verifierPath = path.resolve(__dirname, '../services/trailerSemanticVerifier.js');
const visionPath = path.resolve(__dirname, '../services/trailerVisionService.js');
const dbPath = path.resolve(__dirname, '../database/db.js');
const detectionPath = path.resolve(__dirname, '../services/trailerMasterList/detection.js');
const geoPath = path.resolve(__dirname, '../services/trailerGeocodeService.js');

/** Approving normalized AI result: one confirmed completed event per unit. */
function approveUnits(units) {
  return {
    status: 'ok',
    trailerRelated: true,
    intent: units[0].action === 'pickup' ? 'confirmed_pickup' : 'confirmed_dropoff',
    action: units[0].action,
    completed: true,
    trailerEvents: units.map((u, i) => ({
      eventIndex: i,
      trailerUnit: u.unit,
      intent: u.action === 'pickup' ? 'confirmed_pickup' : 'confirmed_dropoff',
      action: u.action,
      completed: true,
      unitGrounded: true,
      unitSource: 'current_text',
      unitEvidence: u.unit,
      possessionStatus: u.action === 'pickup' ? 'with_driver' : 'dropped',
      cargoStatus: 'unknown',
      locationText: u.locationText || null,
      conditionText: null,
      actionEvidence: u.action,
      confidence: 96,
      reason: 'test approval',
    })),
    language: 'en',
    needsReview: false,
    aiModel: 'test-model',
  };
}

function loadMonitor({ aiResult } = {}) {
  const state = { events: [], statusUpdates: [], unmatchedMentions: [] };
  const fakeDb = {
    getTrailerSettings: async () => ({
      enabled: true, beta_mode: true, automatic_update_test_group_id: null,
      send_driver_group_confirmation: true, send_reaction: true,
      ai_fallback_enabled: true, geocoding_enabled: false,
      semantic_ai_required: true, auto_register_confidence: 92, review_confidence: 75,
    }),
    getDriverProfileByGroupId: async () => ({ id: 5, first_name: 'John', last_name: 'Driver' }),
    // A detection RESOLVES against the authoritative master list and can never
    // create a trailer. Default: the unit is a known ACTIVE OFFICIAL trailer, so
    // known-trailer ingestion behaves exactly as before.
    resolveTrailerByUnitOrAlias: async (unit) => (unit
      ? { trailer: { id: 100 + state.events.length, unit_number: unit }, official: true, matchedBy: 'unit_number', normalizedUnit: unit }
      : { trailer: null, official: false, matchedBy: null, normalizedUnit: null }),
    recordUnmatchedMention: async (evidence) => {
      state.unmatchedMentions.push(evidence);
      return { id: state.unmatchedMentions.length, ...evidence };
    },
    getTrailerByUnitNumber: async (unit) => (unit ? { id: 100, unit_number: unit } : null),
    getTrailerCurrentStatus: async () => null,
    insertTrailerEvent: async (input) => {
      // Dedupe by (group, message, event_index), mirroring the real unique index.
      const key = `${input.telegram_group_id}:${input.telegram_message_id}:${input.event_index || 0}`;
      if (state.events.some((e) => e._key === key)) return { event: null, duplicate: true };
      const event = { id: state.events.length + 1, _key: key, ...input };
      state.events.push(event);
      return { event, duplicate: false };
    },
    applyEventToCurrentStatus: async (trailer, event) => { state.statusUpdates.push({ trailer, event }); return {}; },
    query: async () => ({ rows: [], rowCount: 0 }),
  };
  const fakeVision = {
    photoDescriptor: () => null,
    extractTrailerUnitsFromTelegramImage: async () => null,
    isVisionConfigured: () => false,
  };

  // detectionPath captures `db` at require time, so it MUST be purged with the
  // monitor — otherwise it stays bound to a previous test's fake db and quietly
  // records into the wrong state.
  for (const p of [monitorPath, contextPath, verifierPath, detectionPath]) delete require.cache[p];
  require.cache[dbPath] = { exports: fakeDb };
  require.cache[visionPath] = { exports: fakeVision };
  // Geocoding disabled in settings, but stub anyway so nothing can hit network.
  require.cache[geoPath] = { exports: { geocodeTrailerLocation: async () => ({ lat: null, lng: null, source: 'text_only', confidence: 0 }) } };
  const realVerifier = require(verifierPath);
  require.cache[verifierPath] = {
    exports: {
      ...realVerifier,
      isSemanticAiConfigured: () => aiResult !== undefined,
      verifyTrailerSemantics: async () => (aiResult === undefined ? { status: 'unavailable' } : aiResult),
    },
  };
  delete require.cache[monitorPath];
  return { mod: require(monitorPath), state };
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

const TWO_TRAILER_AI = approveUnits([
  { unit: '403279', action: 'pickup' },
  { unit: '171847', action: 'dropoff' },
]);

test('single-trailer message creates exactly one event (contract preserved)', async () => {
  const { mod, state } = loadMonitor({ aiResult: approveUnits([{ unit: 'ST508998', action: 'pickup', locationText: 'Reno NV' }]) });
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('trl # ST508998 picked up\nLocation: Reno NV'));
  assert.equal(res.registered, true);
  assert.equal(res.registeredCount, 1);
  assert.equal(state.events.length, 1);
});

test('two-trailer message creates two events with distinct event_index', async () => {
  const { mod, state } = loadMonitor({ aiResult: TWO_TRAILER_AI });
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('TRL# 403279 picked up\nTRL# 171847 dropped'));
  assert.equal(res.registered, true);
  assert.equal(res.registeredCount, 2);
  assert.equal(state.events.length, 2);
  assert.deepEqual(state.events.map((e) => e.event_index), [0, 1]);
  assert.deepEqual(state.events.map((e) => e.event_type), ['pickup', 'dropoff']);
  assert.equal(state.statusUpdates.length, 2);
});

test('multi-trailer message registers both events SILENTLY (no reply, no reaction)', async () => {
  const { mod, state } = loadMonitor({ aiResult: TWO_TRAILER_AI });
  const tg = makeTelegram();
  await mod.handleTrailerGroupMessage(tg, GROUP, msg('TRL# 403279 picked up\nTRL# 171847 dropped'));
  // Both trailers register…
  assert.equal(state.events.length, 2);
  // …but silent mode (default) sends nothing back to the driver group.
  const replies = tg.sent.filter((m) => String(m.chatId) === String(GROUP.telegram_group_id));
  assert.equal(replies.length, 0, 'driver group sends = 0');
  assert.equal(tg.reactions.length, 0, 'driver group reactions = 0');
});

test('resending the same multi-trailer message creates no duplicate events', async () => {
  const { mod, state } = loadMonitor({ aiResult: TWO_TRAILER_AI });
  const tg = makeTelegram();
  await mod.handleTrailerGroupMessage(tg, GROUP, msg('TRL# 403279 picked up\nTRL# 171847 dropped'));
  const res2 = await mod.handleTrailerGroupMessage(tg, GROUP, msg('TRL# 403279 picked up\nTRL# 171847 dropped'));
  assert.equal(state.events.length, 2); // still 2, not 4
  assert.equal(res2.skipped, 'duplicate');
});
