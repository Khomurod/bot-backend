/**
 * End-to-end tests for the mandatory-semantic-verification pipeline
 * (services/trailerMonitorService.js): cheap filter → context (real service,
 * fake vision) → deterministic extraction → MOCKED AI semantic verification →
 * REAL hard approval gate → registration / review / ignore.
 *
 * Covers the real production incident: replying "shu TRL ni olasiz" to a photo
 * containing "Trailer #: SWFZ233611" must never register a pickup, while
 * "oldim" on the same reply must.
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

/**
 * Load the monitor with:
 *  - a fake db (records events/status updates),
 *  - a fake vision service (photo → configured units, no network),
 *  - the REAL semantic verifier module except verifyTrailerSemantics, which
 *    returns `aiResult` ('unavailable' when none given) — the REAL approval
 *    gate still runs against the REAL collected context.
 */
function loadPipeline({ aiResult, settings = {}, forceDuplicate = false, visionUnitsByFileId = {} } = {}) {
  const state = { events: [], statusUpdates: [], queries: [], instructions: [] };
  const fakeDb = {
    insertTrailerPendingInstruction: async (input) => {
      const instruction = { id: state.instructions.length + 1, instruction_status: 'pending', ...input };
      state.instructions.push(instruction);
      return { instruction, duplicate: false };
    },
    getLatestPendingInstruction: async () => null,
    markPendingInstructionConfirmed: async (id, opts) => ({ id, ...opts }),
    getTrailerSettings: async () => ({
      enabled: true, beta_mode: true, automatic_update_test_group_id: null,
      send_driver_group_confirmation: true, send_reaction: true,
      ai_fallback_enabled: true, geocoding_enabled: false,
      semantic_ai_required: true, auto_register_confidence: 92, review_confidence: 75,
      ...settings,
    }),
    getDriverProfileByGroupId: async () => ({ id: 5, first_name: 'John', last_name: 'Driver' }),
    ensureTrailerForDetection: async (unit) => ({ id: 100, unit_number: unit }),
    getTrailerByUnitNumber: async (unit) => (unit ? { id: 100, unit_number: unit } : null),
    getTrailerCurrentStatus: async () => null,
    insertTrailerEvent: async (input) => {
      if (forceDuplicate) return { event: { id: 1, ...input }, duplicate: true };
      const event = { id: state.events.length + 1, ...input };
      state.events.push(event);
      return { event, duplicate: false };
    },
    applyEventToCurrentStatus: async (trailer, event) => { state.statusUpdates.push({ trailer, event }); return {}; },
    query: async (sql, params) => { state.queries.push({ sql, params }); return { rows: [], rowCount: 0 }; },
  };

  const fakeVision = {
    photoDescriptor: (message) => {
      if (!message) return null;
      if (Array.isArray(message.photo) && message.photo.length) {
        const largest = message.photo[message.photo.length - 1];
        return { fileId: largest.file_id, fileUniqueId: largest.file_unique_id || null };
      }
      return null;
    },
    extractTrailerUnitsFromTelegramImage: async (_tg, { fileId, source }) => {
      const units = visionUnitsByFileId[fileId];
      if (!units) return null;
      return { trailerUnits: units.map((u) => ({ ...u, source })), visibleText: null, aiModel: 'test-vision' };
    },
    isVisionConfigured: () => true,
  };

  // Real verifier (for the gate + normalization), with the AI call mocked.
  for (const p of [monitorPath, contextPath, verifierPath]) delete require.cache[p];
  require.cache[dbPath] = { exports: fakeDb };
  require.cache[visionPath] = { exports: fakeVision };
  const realVerifier = require(verifierPath);
  const calls = { verify: 0 };
  require.cache[verifierPath] = {
    exports: {
      ...realVerifier,
      isSemanticAiConfigured: () => aiResult !== undefined,
      verifyTrailerSemantics: async (context, det, opts) => {
        calls.verify += 1;
        calls.lastContext = context;
        if (aiResult === undefined) return { status: 'unavailable' };
        if (typeof aiResult === 'function') return aiResult(context, det, opts);
        return aiResult;
      },
    },
  };
  delete require.cache[monitorPath];
  const mod = require(monitorPath);
  return { mod, state, calls };
}

function makeTelegram() {
  const sent = [];
  const reactions = [];
  return {
    sent, reactions,
    sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return { message_id: 999 }; },
    setMessageReaction: async (chatId, messageId, reaction) => { reactions.push({ chatId, messageId, reaction }); },
    getFileLink: async () => { throw new Error('no network in tests'); },
  };
}

const GROUP = { id: 1, telegram_group_id: -100123, group_name: 'Driver 55', group_type: 'driver', active: true };

function msg(text, extra = {}) {
  return { message_id: 42, date: Math.floor(Date.now() / 1000), from: { id: 777, username: 'reporter', first_name: 'Rep' }, text, ...extra };
}

/** Normalized-result factory matching the verifier's output shape. */
function ok({ intent, action, completed, events, needsReview = false, language = 'en' }) {
  return {
    status: 'ok', trailerRelated: true, intent, action, completed,
    trailerEvents: events.map((e, i) => ({
      eventIndex: i,
      trailerUnit: e.unit || null,
      intent: e.intent || intent,
      action: e.action !== undefined ? e.action : action,
      completed: e.completed !== undefined ? e.completed : completed,
      unitGrounded: e.unitGrounded !== false,
      unitSource: e.unitSource || 'current_text',
      unitEvidence: e.unitEvidence || e.unit || null,
      possessionStatus: e.possessionStatus || 'unknown',
      cargoStatus: e.cargoStatus || 'unknown',
      locationText: e.locationText || null,
      conditionText: e.conditionText || null,
      actionEvidence: e.actionEvidence || null,
      confidence: e.confidence != null ? e.confidence : 96,
      reason: e.reason || 'test',
    })),
    language, needsReview, aiModel: 'test-model',
  };
}

const REPLIED_PHOTO_MSG = {
  message_id: 7,
  from: { id: 555, username: 'dispatcher', first_name: 'Disp' },
  photo: [{ file_id: 'small', file_unique_id: 'u-small' }, { file_id: 'photo-1', file_unique_id: 'u-photo-1' }],
};
const SWFZ_VISION = { 'photo-1': [{ value: 'SWFZ233611', confidence: 98, exactEvidence: 'Trailer #: SWFZ233611' }] };

// ─── THE REAL INCIDENT ───

test('"shu TRL ni olasiz" replying to a trailer photo: NO pickup, NO reply, NO reaction, NO status change', async () => {
  const { mod, state, calls } = loadPipeline({
    visionUnitsByFileId: SWFZ_VISION,
    aiResult: ok({
      intent: 'instruction_pickup', action: 'pickup', completed: false,
      events: [{
        unit: 'SWFZ233611', intent: 'instruction_pickup', completed: false,
        unitSource: 'replied_image', unitEvidence: 'Trailer #: SWFZ233611',
        actionEvidence: 'shu TRL ni olasiz', confidence: 95,
        reason: 'instructs a future pickup; not completed',
      }],
      language: 'uz',
    }),
  });
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('shu TRL ni olasiz', { reply_to_message: REPLIED_PHOTO_MSG }));

  assert.equal(calls.verify, 1, 'semantic verification ran');
  // Context actually inspected the replied image.
  assert.equal(calls.lastContext.repliedImage.trailerUnits[0].value, 'SWFZ233611');
  // No pickup/dropoff registered; no status change.
  assert.ok(!state.events.some((e) => e.event_type === 'pickup' || e.event_type === 'dropoff'));
  assert.equal(state.statusUpdates.length, 0);
  // No driver-group reply, no reaction.
  assert.ok(!tg.sent.some((m) => String(m.chatId) === String(GROUP.telegram_group_id)));
  assert.equal(tg.reactions.length, 0);
  // A grounded instruction is captured as a PENDING instruction (not a completed
  // event, not a manual-review item). No unidentified review row is created.
  assert.equal(res.planned, true);
  assert.ok(!state.events.some((e) => e.event_type === 'unidentified'));
  assert.equal(state.instructions.length, 1);
  assert.equal(state.instructions[0].trailer_unit_number, 'SWFZ233611');
  assert.equal(state.instructions[0].planned_action, 'pickup');
});

test('"oldim" replying to the same photo: pickup registered as SWFZ233611, silently (no reply/reaction)', async () => {
  const { mod, state } = loadPipeline({
    visionUnitsByFileId: SWFZ_VISION,
    aiResult: ok({
      intent: 'confirmed_pickup', action: 'pickup', completed: true,
      events: [{
        unit: 'SWFZ233611', completed: true, unitSource: 'replied_image',
        unitEvidence: 'Trailer #: SWFZ233611', actionEvidence: 'oldim',
        possessionStatus: 'with_driver', confidence: 96,
        reason: 'oldim = I took it (completed)',
      }],
      language: 'uz',
    }),
  });
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('oldim', { reply_to_message: REPLIED_PHOTO_MSG }));

  assert.equal(res.registered, true);
  assert.equal(res.unit, 'SWFZ233611');
  const event = state.events.find((e) => e.event_type === 'pickup');
  assert.ok(event, 'pickup stored');
  assert.equal(event.trailer_unit_number, 'SWFZ233611');
  assert.equal(event.possession_status, 'with_driver');
  assert.equal(event.cargo_status, 'unknown'); // pickup without cargo evidence
  assert.equal(event.unit_source, 'replied_image');
  assert.equal(event.ai_verification_status, 'approved');
  assert.equal(state.statusUpdates.length, 1, 'current status advanced');
  // Silent mode (default): nothing sent back to the driver group, no reaction.
  assert.ok(!tg.sent.some((m) => String(m.chatId) === String(GROUP.telegram_group_id)));
  assert.equal(tg.reactions.length, 0);
});

// ─── intent matrix (the AI classifies; the pipeline must obey) ───

const INTENT_CASES = [
  ['Picked up trailer 403279', 'confirmed_pickup', 'pickup', true, true],
  ['Pick up trailer 403279', 'instruction_pickup', 'pickup', false, false],
  ['I will pick up trailer 403279', 'planned_pickup', 'pickup', false, false],
  ['Can you pick up trailer 403279?', 'pickup_question', 'pickup', false, false],
  ['Dropped trailer 403279 at Lancaster', 'confirmed_dropoff', 'dropoff', true, true],
  ['I will drop trailer 403279 later', 'planned_dropoff', 'dropoff', false, false],
];

for (const [text, intent, action, completed, shouldRegister] of INTENT_CASES) {
  test(`"${text}" → ${intent} → ${shouldRegister ? 'registers' : 'does NOT register'}`, async () => {
    const { mod, state } = loadPipeline({
      aiResult: ok({
        intent, action, completed,
        events: [{
          unit: '403279', intent, completed,
          possessionStatus: completed ? (action === 'pickup' ? 'with_driver' : 'dropped') : 'unknown',
          locationText: /Lancaster/.test(text) ? 'Lancaster' : null,
          actionEvidence: text, confidence: 95,
        }],
      }),
    });
    const tg = makeTelegram();
    const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg(text));
    const registered = state.events.filter((e) => e.event_type === 'pickup' || e.event_type === 'dropoff');
    if (shouldRegister) {
      assert.equal(res.registered, true);
      assert.equal(registered.length, 1);
      assert.equal(registered[0].event_type, action);
      assert.equal(state.statusUpdates.length, 1);
    } else {
      assert.ok(!res.registered, 'must not register');
      assert.equal(registered.length, 0);
      assert.equal(state.statusUpdates.length, 0);
      assert.ok(!tg.sent.some((m) => String(m.chatId) === String(GROUP.telegram_group_id)), 'no driver reply');
      assert.equal(tg.reactions.length, 0, 'no reaction');
    }
  });
}

test('multilingual plans/instructions never register (olaman/olasiz/забери/заберу)', async () => {
  for (const [text, intent] of [
    ['olaman trailer 403279', 'planned_pickup'],
    ['olasiz trailer 403279', 'instruction_pickup'],
    ['забери trailer 403279', 'instruction_pickup'],
    ['заберу trailer 403279', 'planned_pickup'],
  ]) {
    const { mod, state } = loadPipeline({
      aiResult: ok({
        intent, action: 'pickup', completed: false,
        events: [{ unit: '403279', intent, completed: false, confidence: 94, actionEvidence: text }],
      }),
    });
    const tg = makeTelegram();
    await mod.handleTrailerGroupMessage(tg, GROUP, msg(text));
    assert.equal(state.events.filter((e) => e.event_type === 'pickup').length, 0, `${text} must not register`);
    assert.equal(state.statusUpdates.length, 0);
  }
});

test('"забрал" (completed Russian pickup) registers', async () => {
  const { mod, state } = loadPipeline({
    aiResult: ok({
      intent: 'confirmed_pickup', action: 'pickup', completed: true,
      events: [{ unit: '403279', completed: true, possessionStatus: 'with_driver', confidence: 95, actionEvidence: 'забрал' }],
      language: 'ru',
    }),
  });
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('забрал trailer 403279'));
  assert.equal(res.registered, true);
  assert.equal(state.events[0].event_type, 'pickup');
});

// ─── fail-closed behavior ───

test('AI unavailable → NO registration, NO driver reply, candidate goes to review (fail closed)', async () => {
  const { mod, state } = loadPipeline({}); // aiResult undefined → 'unavailable'
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('trl # VT700669 picked up\nLocation: Reno NV'));
  assert.equal(res.failedClosed, true);
  assert.ok(!state.events.some((e) => e.event_type === 'pickup'));
  assert.equal(state.statusUpdates.length, 0);
  assert.ok(!tg.sent.some((m) => String(m.chatId) === String(GROUP.telegram_group_id)), 'no "registered" reply');
  assert.equal(tg.reactions.length, 0);
  const review = state.events[0];
  assert.equal(review.event_type, 'unidentified');
  assert.equal(review.ai_verification_status, 'unavailable');
  // Reported to the test group for a human to look at.
  assert.ok(tg.sent.some((m) => String(m.chatId) === '-100999'));
});

test('AI timeout/error and invalid JSON also fail closed', async () => {
  for (const [aiResult, status] of [
    [{ status: 'error', error: 'timed out' }, 'unavailable'],
    [{ status: 'invalid_response' }, 'invalid_response'],
  ]) {
    const { mod, state } = loadPipeline({ aiResult });
    const tg = makeTelegram();
    const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('trl # VT700669 picked up'));
    assert.equal(res.failedClosed, true);
    assert.equal(state.statusUpdates.length, 0);
    assert.equal(state.events[0].ai_verification_status, status);
    assert.ok(!tg.sent.some((m) => String(m.chatId) === String(GROUP.telegram_group_id)));
  }
});

test('confidence between thresholds → review only; below review threshold → ignored', async () => {
  // 85: review (no registration, no reply, review row stored)
  let loaded = loadPipeline({
    aiResult: ok({
      intent: 'confirmed_pickup', action: 'pickup', completed: true,
      events: [{ unit: '403279', completed: true, confidence: 85 }],
    }),
  });
  let tg = makeTelegram();
  let res = await loaded.mod.handleTrailerGroupMessage(tg, GROUP, msg('picked up trailer 403279'));
  assert.equal(res.review, true);
  assert.equal(loaded.state.statusUpdates.length, 0);
  assert.equal(loaded.state.events[0].event_type, 'unidentified');

  // 60: ignored silently (no rows at all)
  loaded = loadPipeline({
    aiResult: ok({
      intent: 'confirmed_pickup', action: 'pickup', completed: true,
      events: [{ unit: '403279', completed: true, confidence: 60 }],
    }),
  });
  tg = makeTelegram();
  res = await loaded.mod.handleTrailerGroupMessage(tg, GROUP, msg('picked up trailer 403279'));
  assert.ok(!res.registered && !res.review);
  assert.equal(loaded.state.events.length, 0);
});

test('hallucinated unit (not grounded anywhere) cannot register even from a confident AI', async () => {
  const { mod, state } = loadPipeline({
    aiResult: ok({
      intent: 'confirmed_pickup', action: 'pickup', completed: true,
      events: [{ unit: 'GHOST9999', completed: true, confidence: 99 }],
    }),
  });
  const tg = makeTelegram();
  await mod.handleTrailerGroupMessage(tg, GROUP, msg('picked up the trailer')); // GHOST9999 appears nowhere
  assert.ok(!state.events.some((e) => e.event_type === 'pickup'));
  assert.equal(state.statusUpdates.length, 0);
});

test('duplicate message → no duplicate registration and no re-reply', async () => {
  const { mod } = loadPipeline({
    forceDuplicate: true,
    aiResult: ok({
      intent: 'confirmed_pickup', action: 'pickup', completed: true,
      events: [{ unit: '403279', completed: true, possessionStatus: 'with_driver', confidence: 96 }],
    }),
  });
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('picked up trailer 403279'));
  assert.equal(res.skipped, 'duplicate');
  assert.equal(tg.sent.length, 0);
  assert.equal(tg.reactions.length, 0);
});

// ─── multi-event ───

test('one confirmed + one planned: only the confirmed trailer registers', async () => {
  const text = 'TRL# 403279 picked up\nTRL# 171847 will be dropped later';
  const { mod, state } = loadPipeline({
    aiResult: ok({
      intent: 'confirmed_pickup', action: 'pickup', completed: true,
      events: [
        { unit: '403279', intent: 'confirmed_pickup', action: 'pickup', completed: true, possessionStatus: 'with_driver', confidence: 95, actionEvidence: 'picked up' },
        { unit: '171847', intent: 'planned_dropoff', action: 'dropoff', completed: false, confidence: 93, actionEvidence: 'will be dropped later' },
      ],
    }),
  });
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg(text));
  assert.equal(res.registered, true);
  assert.equal(res.registeredCount, 1);
  const registered = state.events.filter((e) => e.event_type === 'pickup' || e.event_type === 'dropoff');
  assert.equal(registered.length, 1);
  assert.equal(registered[0].trailer_unit_number, '403279');
  assert.equal(state.statusUpdates.length, 1, '171847 status untouched');
  // The planned drop-off is captured as a PENDING instruction (not a completed
  // event, not a manual-review 'unidentified' row).
  assert.ok(!state.events.some((e) => e.event_type === 'unidentified'), 'no manual-review row for the plan');
  const instruction = state.instructions.find((i) => i.trailer_unit_number === '171847');
  assert.ok(instruction, 'planned drop-off recorded as an instruction');
  assert.equal(instruction.planned_action, 'dropoff');
  // Silent mode (default): only the confirmed trailer registers, and nothing is
  // sent back to the driver group.
  assert.ok(!tg.sent.some((m) => String(m.chatId) === String(GROUP.telegram_group_id)));
  assert.equal(tg.reactions.length, 0);
});

test('two confirmed events → two registered rows with distinct event_index', async () => {
  const text = 'TRL# 403279 picked up\nTRL# 171847 dropped';
  const { mod, state } = loadPipeline({
    aiResult: ok({
      intent: 'confirmed_pickup', action: 'pickup', completed: true,
      events: [
        { unit: '403279', intent: 'confirmed_pickup', action: 'pickup', completed: true, possessionStatus: 'with_driver', confidence: 95 },
        { unit: '171847', intent: 'confirmed_dropoff', action: 'dropoff', completed: true, possessionStatus: 'dropped', confidence: 95 },
      ],
    }),
  });
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg(text));
  assert.equal(res.registeredCount, 2);
  const registered = state.events.filter((e) => e.event_type === 'pickup' || e.event_type === 'dropoff');
  assert.equal(registered.length, 2);
  assert.notEqual(registered[0].event_index, registered[1].event_index);
  assert.equal(registered[1].event_type, 'dropoff');
  assert.equal(registered[1].cargo_status, 'empty'); // dropped ⇒ empty default
  // Silent mode (default): both register, but zero driver-group replies/reactions.
  assert.equal(tg.sent.filter((m) => String(m.chatId) === String(GROUP.telegram_group_id)).length, 0);
  assert.equal(tg.reactions.length, 0);
});

test('valid unit + facility number: only the real trailer is processed (Home Depot #5829)', async () => {
  const text = 'Trailer 403279 dropped\nLocation: Home Depot MDO/DFC #5829\nCondition: no full pictures';
  const { mod, state, calls } = loadPipeline({
    aiResult: ok({
      intent: 'confirmed_dropoff', action: 'dropoff', completed: true,
      events: [{
        unit: '403279', intent: 'confirmed_dropoff', action: 'dropoff', completed: true,
        possessionStatus: 'dropped', locationText: 'Home Depot MDO/DFC #5829',
        conditionText: 'no full pictures', confidence: 95, actionEvidence: 'dropped',
      }],
    }),
  });
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg(text));
  assert.equal(res.registered, true);
  const registered = state.events.filter((e) => e.event_type === 'dropoff');
  assert.equal(registered.length, 1);
  assert.equal(registered[0].trailer_unit_number, '403279');
  assert.ok(!state.events.some((e) => e.trailer_unit_number === '5829'), 'facility 5829 never becomes a trailer');
  // Cargo: "no full pictures" is NOT loaded → dropped/empty.
  assert.equal(registered[0].cargo_status, 'empty');
  // Deterministic candidates fed to the AI never contained 5829 either.
  const detUnits = (calls.lastContext.candidateUnits || []).map((u) => u.value);
  assert.ok(!detUnits.includes('5829'));
});

// ─── settings / cost controls ───

test('non-candidate chatter never reaches the AI', async () => {
  const { mod, calls } = loadPipeline({ aiResult: ok({ intent: 'discussion', action: null, completed: false, events: [] }) });
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('running late, be there in 2 hours'));
  assert.equal(res.skipped, 'not-trailer');
  assert.equal(calls.verify, 0, 'no AI call for ordinary chatter');
});

test('mention-only messages (no action signal) skip AI and keep the review ledger', async () => {
  const { mod, state, calls } = loadPipeline({ aiResult: ok({ intent: 'trailer_mention', action: null, completed: false, events: [] }) });
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('trailer ST508998 where is it'));
  assert.equal(calls.verify, 0, 'no state change possible → no AI call');
  assert.equal(res.unidentified, true);
  assert.equal(state.events[0].event_type, 'mention_only');
});

test('feature disabled → nothing runs', async () => {
  const { mod, calls } = loadPipeline({ settings: { enabled: false } });
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('trl # VT700669 picked up'));
  assert.equal(res.skipped, 'disabled');
  assert.equal(calls.verify, 0);
});
