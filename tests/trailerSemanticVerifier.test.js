/**
 * Semantic verifier + hard approval gate (services/trailerSemanticVerifier.js).
 * The gate is a pure function so intents/thresholds/grounding are tested
 * directly; normalizeAiResult is tested for server-side re-grounding.
 */
delete process.env.GEMINI_API_KEY;

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const sv = require('../services/trailerSemanticVerifier');

const SETTINGS = { auto_register_confidence: 92, review_confidence: 75 };

/** Context whose current text grounds unit 403279. */
const CTX_TEXT = { currentText: 'Picked up trailer 403279', currentCaption: null, repliedMessage: null };
/** Context whose replied image grounds SWFZ233611 ("oldim" reply case). */
const CTX_IMAGE = {
  currentText: 'oldim',
  currentCaption: null,
  repliedMessage: { text: null, caption: null, hasPhoto: true },
  repliedImage: { trailerUnits: [{ value: 'SWFZ233611', confidence: 98, exactEvidence: 'Trailer #: SWFZ233611', source: 'replied_image' }] },
};

function aiEvent(overrides = {}) {
  return {
    eventIndex: 0,
    trailerUnit: '403279',
    intent: 'confirmed_pickup',
    action: 'pickup',
    completed: true,
    unitGrounded: true,
    unitSource: 'current_text',
    unitEvidence: 'trailer 403279',
    possessionStatus: 'with_driver',
    cargoStatus: 'unknown',
    locationText: null,
    conditionText: null,
    actionEvidence: 'Picked up',
    confidence: 96,
    reason: 'sender confirms completion',
    ...overrides,
  };
}

function aiResult(overrides = {}, events = null) {
  const ev = events || [aiEvent(overrides.event || {})];
  return {
    status: 'ok',
    trailerRelated: true,
    intent: overrides.intent || 'confirmed_pickup',
    action: overrides.action !== undefined ? overrides.action : 'pickup',
    completed: overrides.completed !== undefined ? overrides.completed : true,
    trailerEvents: ev,
    language: overrides.language || 'en',
    needsReview: overrides.needsReview === true,
    aiModel: 'test-model',
  };
}

// ── gate: intents ──

test('confirmed_pickup + completed + grounded + high confidence → register', () => {
  const r = aiResult();
  const g = sv.evaluateTrailerEventApproval(r, r.trailerEvents[0], CTX_TEXT, SETTINGS);
  assert.equal(g.allow, true);
  assert.equal(g.disposition, 'register');
  assert.equal(sv.canRegisterTrailerEvent(r, r.trailerEvents[0], CTX_TEXT, SETTINGS), true);
});

test('confirmed_dropoff registers with matching action', () => {
  const ev = aiEvent({ intent: 'confirmed_dropoff', action: 'dropoff', possessionStatus: 'dropped' });
  const r = aiResult({ intent: 'confirmed_dropoff', action: 'dropoff' }, [ev]);
  assert.equal(sv.canRegisterTrailerEvent(r, ev, { currentText: 'Dropped trailer 403279 at Lancaster' }, SETTINGS), true);
});

test('every non-confirmed intent is refused', () => {
  for (const intent of ['planned_pickup', 'planned_dropoff', 'instruction_pickup', 'instruction_dropoff',
    'pickup_question', 'dropoff_question', 'discussion', 'trailer_mention', 'condition_report_only', 'unclear']) {
    const ev = aiEvent({ intent, completed: false });
    const r = aiResult({ intent, completed: false }, [ev]);
    const g = sv.evaluateTrailerEventApproval(r, ev, CTX_TEXT, SETTINGS);
    assert.equal(g.allow, false, `${intent} must not register`);
  }
});

test('questions/discussion are silently ignorable; grounded instructions/plans go to plan; unclear reviews', () => {
  for (const [intent, disposition] of [
    ['pickup_question', 'ignore'], ['dropoff_question', 'ignore'], ['discussion', 'ignore'],
    ['trailer_mention', 'ignore'], ['condition_report_only', 'ignore'],
    // Grounded instructions/plans are recorded as pending instructions, NOT
    // sent to manual review.
    ['instruction_pickup', 'plan'], ['instruction_dropoff', 'plan'],
    ['planned_pickup', 'plan'], ['planned_dropoff', 'plan'],
    ['unclear', 'review'],
  ]) {
    const ev = aiEvent({ intent, completed: false }); // unitGrounded: true by default
    const r = aiResult({ intent, completed: false }, [ev]);
    const g = sv.evaluateTrailerEventApproval(r, ev, CTX_TEXT, SETTINGS);
    assert.equal(g.disposition, disposition, `${intent} → ${disposition}`);
  }
});

test('an UNGROUNDED instruction/plan is ignored (nothing worth storing), not planned', () => {
  for (const intent of ['instruction_pickup', 'planned_dropoff']) {
    const ev = aiEvent({ intent, completed: false, unitGrounded: false });
    const r = aiResult({ intent, completed: false }, [ev]);
    assert.equal(sv.evaluateTrailerEventApproval(r, ev, CTX_TEXT, SETTINGS).disposition, 'ignore');
  }
});

// ── gate: completion / action / grounding ──

test('completed=false on a confirmed intent is refused', () => {
  const ev = aiEvent({ completed: false });
  const r = aiResult({}, [ev]);
  assert.equal(sv.canRegisterTrailerEvent(r, ev, CTX_TEXT, SETTINGS), false);
});

test('action mismatching the intent is refused', () => {
  const ev = aiEvent({ action: 'dropoff' }); // intent stays confirmed_pickup
  const r = aiResult({}, [ev]);
  assert.equal(sv.canRegisterTrailerEvent(r, ev, CTX_TEXT, SETTINGS), false);
});

test('ungrounded unit is refused even when the AI claims unitGrounded', () => {
  const ev = aiEvent({ trailerUnit: '999888' }); // not in context text
  const r = aiResult({}, [ev]);
  assert.equal(sv.canRegisterTrailerEvent(r, ev, CTX_TEXT, SETTINGS), false);
});

test('reserved word TRL can never register even if AI returns it', () => {
  const ev = aiEvent({ trailerUnit: 'TRL', unitEvidence: 'shu TRL ni olasiz' });
  const r = aiResult({}, [ev]);
  const g = sv.evaluateTrailerEventApproval(r, ev, { currentText: 'shu TRL ni olasiz' }, SETTINGS);
  assert.equal(g.allow, false);
});

test('unit grounded ONLY in the replied image registers (oldim + photo)', () => {
  const ev = aiEvent({ trailerUnit: 'SWFZ233611', unitSource: 'replied_image', unitEvidence: 'Trailer #: SWFZ233611', actionEvidence: 'oldim' });
  const r = aiResult({}, [ev]);
  assert.equal(sv.canRegisterTrailerEvent(r, ev, CTX_IMAGE, SETTINGS), true);
});

// ── gate: thresholds ──

test('confidence 92+ registers, 75–91 reviews, <75 ignores', () => {
  const mk = (confidence) => {
    const ev = aiEvent({ confidence });
    const r = aiResult({}, [ev]);
    return sv.evaluateTrailerEventApproval(r, ev, CTX_TEXT, SETTINGS);
  };
  assert.equal(mk(92).allow, true);
  assert.equal(mk(91).allow, false);
  assert.equal(mk(91).disposition, 'review');
  assert.equal(mk(75).disposition, 'review');
  assert.equal(mk(74).disposition, 'ignore');
});

test('thresholds are configurable via settings', () => {
  const ev = aiEvent({ confidence: 85 });
  const r = aiResult({}, [ev]);
  assert.equal(sv.canRegisterTrailerEvent(r, ev, CTX_TEXT, { auto_register_confidence: 80, review_confidence: 60 }), true);
});

test('AI needsReview flag blocks auto-registration', () => {
  const ev = aiEvent();
  const r = aiResult({ needsReview: true }, [ev]);
  const g = sv.evaluateTrailerEventApproval(r, ev, CTX_TEXT, SETTINGS);
  assert.equal(g.allow, false);
  assert.equal(g.disposition, 'review');
});

test('non-ok AI status always fails closed', () => {
  for (const status of ['unavailable', 'error', 'invalid_response']) {
    const g = sv.evaluateTrailerEventApproval({ status }, aiEvent(), CTX_TEXT, SETTINGS);
    assert.equal(g.allow, false, `${status} must fail closed`);
  }
  assert.equal(sv.canRegisterTrailerEvent(null, aiEvent(), CTX_TEXT, SETTINGS), false);
});

// ── normalizeAiResult: server-side re-grounding ──

test('normalizeAiResult forces unitGrounded=false for hallucinated units', () => {
  const parsed = {
    trailerRelated: true,
    intent: 'confirmed_pickup',
    action: 'pickup',
    completed: true,
    trailerEvents: [{
      trailerUnit: 'FAKE9999', intent: 'confirmed_pickup', action: 'pickup', completed: true,
      unitGrounded: true, unitSource: 'current_text', unitEvidence: 'FAKE9999',
      possessionStatus: 'with_driver', cargoStatus: 'unknown', confidence: 99, reason: 'x',
    }],
    language: 'en',
    needsReview: false,
  };
  const norm = sv.normalizeAiResult(parsed, CTX_TEXT);
  assert.equal(norm.trailerEvents[0].unitGrounded, false, 'server-side grounding must win');
  const g = sv.evaluateTrailerEventApproval(norm, norm.trailerEvents[0], CTX_TEXT, SETTINGS);
  assert.equal(g.allow, false);
});

test('normalizeAiResult grounds a replied-image unit and keeps its source', () => {
  const parsed = {
    trailerRelated: true,
    intent: 'confirmed_pickup',
    action: 'pickup',
    completed: true,
    trailerEvents: [{
      trailerUnit: 'SWFZ233611', intent: 'confirmed_pickup', action: 'pickup', completed: true,
      unitGrounded: true, unitSource: 'replied_image', unitEvidence: 'Trailer #: SWFZ233611',
      possessionStatus: 'with_driver', cargoStatus: 'unknown', confidence: 96, reason: 'oldim = picked up',
    }],
    language: 'uz',
    needsReview: false,
  };
  const norm = sv.normalizeAiResult(parsed, CTX_IMAGE);
  assert.equal(norm.trailerEvents[0].unitGrounded, true);
  assert.equal(norm.trailerEvents[0].unitSource, 'replied_image');
});

test('normalizeAiResult rejects structurally invalid output', () => {
  assert.equal(sv.normalizeAiResult(null, CTX_TEXT), null);
  assert.equal(sv.normalizeAiResult({ intent: 'bogus', trailerEvents: [] }, CTX_TEXT), null);
  assert.equal(sv.normalizeAiResult({ intent: 'confirmed_pickup' }, CTX_TEXT), null); // no array
});

// ── verifier availability / multilingual prompt ──

test('verifyTrailerSemantics fails closed as unavailable without an API key', async () => {
  // GEMINI_API_KEY is unset in the test env (see top of file) → mandatory verification cannot run.
  const res = await sv.verifyTrailerSemantics({ currentText: 'picked up trailer 403279' }, []);
  assert.equal(res.status, 'unavailable');
});

test('system prompt covers EN/RU/UZ, tense, instructions, and quoted-reply rules', () => {
  const s = sv.SYSTEM_PROMPT;
  for (const needle of ['ENGLISH', 'RUSSIAN', 'UZBEK', 'Cyrillic', 'olasiz', 'oldim', 'забрал', 'заберу',
    'instruction', 'question', 'quoted', 'TRL']) {
    assert.ok(s.includes(needle), `system prompt must mention ${needle}`);
  }
});

// ── multi-event independence ──

test('one confirmed + one planned: only the confirmed event passes the gate', () => {
  const ctx = { currentText: 'TRL# 403279 picked up\nTRL# 171847 will be dropped later' };
  const ev1 = aiEvent({ trailerUnit: '403279', confidence: 95 });
  const ev2 = aiEvent({
    trailerUnit: '171847', intent: 'planned_dropoff', action: 'dropoff', completed: false,
    possessionStatus: 'unknown', confidence: 93,
  });
  const r = aiResult({ intent: 'confirmed_pickup' }, [ev1, ev2]);
  assert.equal(sv.canRegisterTrailerEvent(r, ev1, ctx, SETTINGS), true);
  assert.equal(sv.canRegisterTrailerEvent(r, ev2, ctx, SETTINGS), false);
  // The planned drop-off is captured as a pending instruction, not manual review.
  assert.equal(sv.evaluateTrailerEventApproval(r, ev2, ctx, SETTINGS).disposition, 'plan');
});
