/**
 * Phase 1 — INSTRUCTION vs COMPLETED trailer action.
 *
 * Root-cause regression: a trailer specialist posting a DROP-OFF ADDRESS
 * ("Trailer DROP OFF address / trl # VM709984 / 1375 Jersey Ave …") must NOT
 * register a completed drop-off or change the trailer's confirmed status. It is
 * an assignment; it is recorded as a PENDING instruction and the driver group
 * hears nothing. Only a later COMPLETED-action message may change status.
 *
 * Covers: the deterministic parser guard, the semantic approval gate's new
 * 'plan' disposition, and the monitor end-to-end (mocked db / AI / vision).
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
const geoPath = path.resolve(__dirname, '../services/trailerGeocodeService.js');
const dbPath = path.resolve(__dirname, '../database/db.js');
const detectionPath = path.resolve(__dirname, '../services/trailerMasterList/detection.js');
const { purgeTrailerMonitorModules } = require('./helpers/trailerMonitorCache');

const SCREENSHOT_TEXT =
  'Trailer DROP OFF address\ntrl # VM709984\n1375 Jersey Ave, North Brunswick Township, NJ 08902, United States';
const SCREENSHOT_ADDRESS = '1375 Jersey Ave, North Brunswick Township, NJ 08902, United States';

// ── pure parser guard ──────────────────────────────────────────────────────
const parser = require('../services/trailerMessageParser');

test('parser: the exact screenshot is an instruction, not a completed drop-off', () => {
  const parsed = parser.parseTrailerMessage(SCREENSHOT_TEXT);
  assert.equal(parsed.isInstruction, true);
  assert.equal(parsed.instructionAction, 'dropoff');
  assert.notEqual(parsed.eventType, 'dropoff');       // never a completed event
  assert.notEqual(parsed.eventType, 'pickup');
  assert.equal(parsed.possessionStatus, 'unknown');   // no status implied
  assert.equal(parsed.cargoStatus, 'unknown');
  assert.equal(parsed.trailerUnit, 'VM709984');
  assert.match(parsed.locationText, /1375 Jersey Ave/); // address captured as planned location
});

test('parser: instruction/assignment phrases are detected as instructions (not completions)', () => {
  assert.equal(parser.detectInstructionPhrase('Trailer drop-off address'), 'dropoff');
  assert.equal(parser.detectInstructionPhrase('Drop-off location for the trailer'), 'dropoff');
  assert.equal(parser.detectInstructionPhrase('Drop this trailer at the yard'), 'dropoff');
  assert.equal(parser.detectInstructionPhrase('Take this trailer to Newark'), 'dropoff');
  assert.equal(parser.detectInstructionPhrase('Pickup address: 500 Main St'), 'pickup');
  assert.equal(parser.detectInstructionPhrase('Pick it up from here'), 'pickup');
});

test('parser: real completions are NOT misread as instructions', () => {
  assert.equal(parser.detectInstructionPhrase('Dropped trailer VM709984 at 1375 Jersey Ave'), null);
  assert.equal(parser.detectInstructionPhrase('Picked up trailer 403279'), null);
  assert.equal(parser.detectInstructionPhrase('left it there, all done'), null);
  // A completed drop-off still parses as a real dropoff event.
  const done = parser.parseTrailerMessage('Dropped trailer VM709984\nLocation: 1375 Jersey Ave');
  assert.equal(done.eventType, 'dropoff');
  assert.equal(done.isInstruction, false);
});

// ── pure approval gate ──────────────────────────────────────────────────────
const verifier = require('../services/trailerSemanticVerifier');

function aiEvent(overrides = {}) {
  return {
    trailerUnit: 'VM709984', intent: 'instruction_dropoff', action: 'dropoff',
    completed: false, operationalStatusChange: false, unitGrounded: true,
    unitSource: 'current_text', unitEvidence: 'VM709984', plannedLocation: SCREENSHOT_ADDRESS,
    possessionStatus: 'unknown', cargoStatus: 'unknown', confidence: 96, reason: 'address given',
    ...overrides,
  };
}
function aiResult(intent, ev) {
  return { status: 'ok', trailerRelated: true, intent, action: ev.action, completed: ev.completed, trailerEvents: [ev], needsReview: false };
}

test('gate: a grounded instruction_dropoff → disposition "plan" (not review, not register)', () => {
  const ev = aiEvent();
  const g = verifier.evaluateTrailerEventApproval(aiResult('instruction_dropoff', ev), ev, {}, {});
  assert.equal(g.allow, false);
  assert.equal(g.disposition, 'plan');
});

test('gate: an UNGROUNDED instruction → "ignore" (nothing worth storing)', () => {
  const ev = aiEvent({ unitGrounded: false });
  const g = verifier.evaluateTrailerEventApproval(aiResult('instruction_dropoff', ev), ev, {}, {});
  assert.equal(g.disposition, 'ignore');
});

test('gate: planned_pickup → "plan"; questions → "ignore"; unclear → "review"', () => {
  const plan = aiEvent({ intent: 'planned_pickup', action: 'pickup' });
  assert.equal(verifier.evaluateTrailerEventApproval(aiResult('planned_pickup', plan), plan, {}, {}).disposition, 'plan');
  const q = aiEvent({ intent: 'dropoff_question' });
  assert.equal(verifier.evaluateTrailerEventApproval(aiResult('dropoff_question', q), q, {}, {}).disposition, 'ignore');
  const u = aiEvent({ intent: 'unclear' });
  assert.equal(verifier.evaluateTrailerEventApproval(aiResult('unclear', u), u, {}, {}).disposition, 'review');
});

test('gate: confirmed intent but operationalStatusChange=false is refused (never registers)', () => {
  const ev = aiEvent({ intent: 'confirmed_dropoff', completed: true, operationalStatusChange: false });
  const g = verifier.evaluateTrailerEventApproval(aiResult('confirmed_dropoff', ev), ev, {}, {});
  assert.equal(g.allow, false);
});

// ── monitor end-to-end (mocked db / AI / vision / geocode) ──────────────────
function loadMonitor({ settings = {}, aiResult: ai, pendingInstruction = null } = {}) {
  const state = { events: [], statusUpdates: [], instructions: [], confirmedInstructions: [], unmatchedMentions: [] };
  const fakeDb = {
    getTrailerSettings: async () => ({
      enabled: true, beta_mode: true, automatic_update_test_group_id: null,
      send_driver_group_confirmation: true, send_reaction: true,
      ai_fallback_enabled: true, geocoding_enabled: false,
      semantic_ai_required: true, auto_register_confidence: 92, review_confidence: 75,
      silent_driver_group_monitoring: true, ...settings,
    }),
    getDriverProfileByGroupId: async () => ({ id: 5, first_name: 'John', last_name: 'Driver', telegram_user_id: 111 }),
    // A detection RESOLVES against the authoritative master list and can never
    // create a trailer. Default: the unit is a known ACTIVE OFFICIAL trailer, so
    // known-trailer ingestion behaves exactly as before.
    resolveTrailerByUnitOrAlias: async (unit) => (unit
      ? { trailer: { id: 100, unit_number: unit }, official: true, matchedBy: 'unit_number', normalizedUnit: unit }
      : { trailer: null, official: false, matchedBy: null, normalizedUnit: null }),
    recordUnmatchedMention: async (evidence) => {
      state.unmatchedMentions.push(evidence);
      return { id: state.unmatchedMentions.length, ...evidence };
    },
    getTrailerByUnitNumber: async (unit) => (unit ? { id: 100, unit_number: unit } : null),
    getTrailerCurrentStatus: async () => null,
    insertTrailerEvent: async (input) => {
      const event = { id: state.events.length + 1, ...input };
      state.events.push(event);
      return { event, duplicate: false };
    },
    applyEventToCurrentStatus: async (trailer, event) => { state.statusUpdates.push({ trailer, event }); return {}; },
    insertTrailerPendingInstruction: async (input) => {
      const instruction = { id: state.instructions.length + 1, instruction_status: 'pending', ...input };
      state.instructions.push(instruction);
      return { instruction, duplicate: false };
    },
    getLatestPendingInstruction: async () => pendingInstruction,
    markPendingInstructionConfirmed: async (id, opts) => { state.confirmedInstructions.push({ id, opts }); return { id }; },
    query: async () => ({ rows: [], rowCount: 0 }),
  };
  const fakeVision = { photoDescriptor: () => null, extractTrailerUnitsFromTelegramImage: async () => null, isVisionConfigured: () => false };

  // Every module that captured a collaborator at require time must be purged
  // with the monitor — including its stage modules. See the helper.
  purgeTrailerMonitorModules([monitorPath, contextPath, verifierPath, detectionPath]);
  require.cache[dbPath] = { exports: fakeDb };
  require.cache[visionPath] = { exports: fakeVision };
  require.cache[geoPath] = { exports: { geocodeTrailerLocation: async () => ({ lat: null, lng: null, source: 'text_only', confidence: 0 }) } };
  const realVerifier = require(verifierPath);
  require.cache[verifierPath] = {
    exports: {
      ...realVerifier,
      isSemanticAiConfigured: () => ai !== undefined,
      verifyTrailerSemantics: async () => (ai === undefined ? { status: 'unavailable' } : ai),
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
const msg = (text, extra = {}) => ({ message_id: 42, date: Math.floor(Date.now() / 1000), from: { id: 777, username: 'specialist', first_name: 'Spec' }, text, ...extra });

/** Approving instruction_dropoff AI result for the screenshot. */
const INSTRUCTION_AI = {
  status: 'ok', trailerRelated: true, intent: 'instruction_dropoff', action: 'dropoff', completed: false,
  trailerEvents: [{
    eventIndex: 0, trailerUnit: 'VM709984', intent: 'instruction_dropoff', action: 'dropoff',
    completed: false, operationalStatusChange: false, unitGrounded: true, unitSource: 'current_text',
    unitEvidence: 'VM709984', possessionStatus: 'unknown', cargoStatus: 'unknown',
    locationText: SCREENSHOT_ADDRESS, plannedLocation: SCREENSHOT_ADDRESS,
    actionEvidence: 'DROP OFF address', confidence: 96, reason: 'specialist gave a drop-off address',
  }],
  language: 'en', needsReview: false, aiModel: 'test-model',
};

test('REGRESSION: the screenshot registers NO drop-off, stores a pending instruction, stays silent', async () => {
  const { mod, state } = loadMonitor({ aiResult: INSTRUCTION_AI });
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg(SCREENSHOT_TEXT));

  // No completed event, no status change.
  assert.ok(!res.registered, 'must not register a completed event');
  assert.equal(state.events.filter((e) => e.event_type === 'pickup' || e.event_type === 'dropoff').length, 0);
  assert.equal(state.statusUpdates.length, 0, 'confirmed status unchanged');
  // Pending instruction stored with the planned drop-off location.
  assert.equal(res.planned, true);
  assert.equal(state.instructions.length, 1);
  assert.equal(state.instructions[0].trailer_unit_number, 'VM709984');
  assert.equal(state.instructions[0].planned_action, 'dropoff');
  assert.match(state.instructions[0].planned_location, /1375 Jersey Ave/);
  // Silent in the driver group: no reply, no reaction.
  assert.equal(tg.sent.filter((m) => String(m.chatId) === String(GROUP.telegram_group_id)).length, 0);
  assert.equal(tg.reactions.length, 0);
});

test('a later completed drop-off (no address) backfills the planned location and confirms the instruction', async () => {
  const pending = { id: 77, trailer_unit_number: 'VM709984', planned_action: 'dropoff', planned_location: SCREENSHOT_ADDRESS };
  const CONFIRM_AI = {
    status: 'ok', trailerRelated: true, intent: 'confirmed_dropoff', action: 'dropoff', completed: true,
    trailerEvents: [{
      eventIndex: 0, trailerUnit: 'VM709984', intent: 'confirmed_dropoff', action: 'dropoff',
      completed: true, operationalStatusChange: true, unitGrounded: true, unitSource: 'current_text',
      unitEvidence: 'VM709984', possessionStatus: 'dropped', cargoStatus: 'unknown',
      locationText: null, actionEvidence: 'dropped', confidence: 96, reason: 'driver confirmed drop-off',
    }],
    language: 'en', needsReview: false, aiModel: 'test-model',
  };
  const { mod, state } = loadMonitor({ aiResult: CONFIRM_AI, pendingInstruction: pending });
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg('Dropped trailer VM709984'));

  assert.equal(res.registered, true);
  const ev = state.events.find((e) => e.event_type === 'dropoff');
  assert.ok(ev, 'drop-off registered');
  assert.match(ev.location_text, /1375 Jersey Ave/, 'planned address used as the confirmed location');
  assert.equal(state.statusUpdates.length, 1);
  assert.deepEqual(state.confirmedInstructions[0], { id: 77, opts: { confirmedEventId: ev.id } });
  // Still silent.
  assert.equal(tg.sent.filter((m) => String(m.chatId) === String(GROUP.telegram_group_id)).length, 0);
  assert.equal(tg.reactions.length, 0);
});

test('legacy path (semantic_ai_required=false) also treats the screenshot as an instruction, not a drop-off', async () => {
  const { mod, state } = loadMonitor({ settings: { semantic_ai_required: false } }); // no AI
  const tg = makeTelegram();
  const res = await mod.handleTrailerGroupMessage(tg, GROUP, msg(SCREENSHOT_TEXT));
  assert.ok(!res.registered, 'legacy path must not register a completed drop-off');
  assert.equal(state.statusUpdates.length, 0);
  assert.equal(state.events.filter((e) => e.event_type === 'dropoff').length, 0);
  assert.equal(state.instructions.length, 1, 'stored as a pending instruction');
  assert.equal(state.instructions[0].planned_action, 'dropoff');
  assert.equal(tg.sent.filter((m) => String(m.chatId) === String(GROUP.telegram_group_id)).length, 0);
});
