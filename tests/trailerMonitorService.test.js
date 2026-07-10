/**
 * Unit tests for services/trailerMonitorService.js — the Telegram trailer
 * monitor. The db module, the vision service, and the AI semantic verifier are
 * replaced with fakes; a fake `telegram` records sendMessage /
 * setMessageReaction so behavior is asserted without a live DB or network.
 *
 * Contract under test (mandatory semantic verification):
 *   - a pickup/drop-off candidate registers ONLY when the (mocked) AI verifies
 *     a COMPLETED action AND the hard gate passes;
 *   - with no AI available the candidate FAILS CLOSED to review;
 *   - mention-only / unidentified messages keep the review ledger without AI.
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

function loadMonitor({ dbOverrides = {}, aiResult } = {}) {
  const state = { events: [], statusUpdates: [], queries: [] };
  const fakeDb = {
    getTrailerSettings: async () => ({
      enabled: true, beta_mode: true, automatic_update_test_group_id: null,
      send_driver_group_confirmation: true, send_reaction: true,
      ai_fallback_enabled: true, geocoding_enabled: false,
      semantic_ai_required: true, auto_register_confidence: 92, review_confidence: 75,
    }),
    getDriverProfileByGroupId: async () => ({ id: 5, first_name: 'John', last_name: 'Driver' }),
    ensureTrailerForDetection: async (unit) => ({ id: 100, unit_number: unit }),
    getTrailerByUnitNumber: async (unit) => (unit ? { id: 100, unit_number: unit } : null),
    getTrailerCurrentStatus: async () => null,
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
  const fakeVision = {
    photoDescriptor: () => null,
    extractTrailerUnitsFromTelegramImage: async () => null,
    isVisionConfigured: () => false,
  };

  for (const p of [monitorPath, contextPath, verifierPath]) delete require.cache[p];
  require.cache[dbPath] = { exports: fakeDb };
  require.cache[visionPath] = { exports: fakeVision };
  const realVerifier = require(verifierPath);
  require.cache[verifierPath] = {
    exports: {
      ...realVerifier,
      isSemanticAiConfigured: () => aiResult !== undefined,
      verifyTrailerSemantics: async () => (aiResult === undefined ? { status: 'unavailable' } : aiResult),
    },
  };
  delete require.cache[monitorPath];
  const mod = require(monitorPath);
  return { mod, state };
}

/** Normalized approving AI result for one completed event. */
function approve({ unit, action, confidence = 96, locationText = null, conditionText = null }) {
  const intent = action === 'pickup' ? 'confirmed_pickup' : 'confirmed_dropoff';
  return {
    status: 'ok', trailerRelated: true, intent, action, completed: true,
    trailerEvents: [{
      eventIndex: 0, trailerUnit: unit, intent, action, completed: true,
      unitGrounded: true, unitSource: 'current_text', unitEvidence: unit,
      possessionStatus: action === 'pickup' ? 'with_driver' : 'dropped',
      cargoStatus: 'unknown', locationText, conditionText,
      actionEvidence: action, confidence, reason: 'test approval',
    }],
    language: 'en', needsReview: false, aiModel: 'test-model',
  };
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

test('AI-verified pickup registers event, replies to driver group, reacts 👍', async () => {
  const { mod, state } = loadMonitor({
    aiResult: approve({ unit: 'VT700669', action: 'pickup', locationText: 'Lancaster PA', conditionText: 'no pictures' }),
  });
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg(
    'trl # VT700669\nPicked up by: ENICSON JEAN\nLocation: Lancaster PA\nCondition: no pictures'
  ));
  assert.equal(res.registered, true);
  assert.equal(res.eventType, 'pickup');
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].event_type, 'pickup');
  assert.equal(state.events[0].condition_text, 'no pictures');
  assert.equal(state.events[0].ai_verification_status, 'approved');
  assert.equal(state.statusUpdates.length, 1); // current status updated
  // Reply to the ORIGINAL message, labeled Beta.
  const reply = tg.sent.find((m) => String(m.chatId) === String(GROUP.telegram_group_id));
  assert.ok(reply);
  assert.match(reply.text, /pickup registered/i);
  assert.match(reply.text, /Beta test mode/i);
  assert.equal(reply.opts.reply_to_message_id, 42);
  assert.equal(tg.reactions.length, 1);
});

test('AI-verified dropoff registers event and updates status', async () => {
  const { mod, state } = loadMonitor({
    aiResult: approve({ unit: 'ST508998', action: 'dropoff', locationText: 'Lancaster PA' }),
  });
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg(
    'trl # ST508998\nDropped by: ENICSON JEAN\nLocation: Lancaster PA\nCondition: no pictures'
  ));
  assert.equal(res.eventType, 'dropoff');
  assert.equal(state.events[0].event_type, 'dropoff');
  assert.equal(state.events[0].cargo_status, 'empty'); // dropped ⇒ empty default
  assert.equal(state.statusUpdates.length, 1);
});

test('WITHOUT AI a deterministic pickup candidate FAILS CLOSED: review only, no reply', async () => {
  const { mod, state } = loadMonitor(); // aiResult undefined → unavailable
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('trl # VT700669 picked up\nLocation: Reno NV'));
  assert.equal(res.failedClosed, true);
  assert.equal(state.statusUpdates.length, 0);
  assert.equal(state.events[0].event_type, 'unidentified');
  assert.equal(state.events[0].ai_verification_status, 'unavailable');
  assert.ok(!tg.sent.some((m) => String(m.chatId) === String(GROUP.telegram_group_id)));
  assert.equal(tg.reactions.length, 0);
});

test('unidentified "trailer?" does NOT reply to driver group', async () => {
  const { mod } = loadMonitor();
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('trailer?'));
  assert.equal(res.unidentified, true);
  // No confirmation to the driver group.
  assert.ok(!tg.sent.some((m) => String(m.chatId) === String(GROUP.telegram_group_id)));
});

test('unidentified WITH a unit but no action reports to the test group (no AI needed)', async () => {
  const { mod } = loadMonitor();
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('trailer ST508998 where is it'));
  assert.equal(res.reportedToTest, true);
  const report = tg.sent.find((m) => String(m.chatId) === '-100999');
  assert.ok(report, 'test-group report sent');
  assert.match(report.text, /Unidentified trailer command/i);
});

test('duplicate Telegram message does not double-register or re-reply', async () => {
  const { mod } = loadMonitor({
    dbOverrides: { forceDuplicate: true },
    aiResult: approve({ unit: 'VT700669', action: 'pickup', locationText: 'Reno NV' }),
  });
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

test('photo with caption is processed as an AI-verified pickup', async () => {
  const { mod, state } = loadMonitor({ aiResult: approve({ unit: 'AB123', action: 'pickup', locationText: 'Dallas TX' }) });
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

test('semantic_ai_required=false (explicit opt-out) restores legacy deterministic registration', async () => {
  const { mod, state } = loadMonitor({
    dbOverrides: {
      db: {
        getTrailerSettings: async () => ({
          enabled: true, beta_mode: true, automatic_update_test_group_id: null,
          send_driver_group_confirmation: true, send_reaction: true,
          ai_fallback_enabled: true, geocoding_enabled: false,
          semantic_ai_required: false,
        }),
      },
    },
  });
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('trl # VT700669 picked up\nLocation: Reno NV'));
  assert.equal(res.registered, true);
  assert.equal(res.legacy, true);
  assert.equal(state.events[0].event_type, 'pickup');
});
