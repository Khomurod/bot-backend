/**
 * Trailer semantic verification — the MANDATORY AI layer between a trailer
 * candidate message and any trailer status change.
 *
 * The deterministic parser only nominates candidates; it can no longer
 * authorize a pickup/drop-off on its own. For every candidate that could
 * change trailer state, this service asks the app's integrated Gemini stack
 * (services/geminiClient.js — the same shared key/config every other feature
 * uses) what the sender actually MEANT:
 *
 *   completed past action?  future plan?  command to someone else?  question?
 *   ordinary discussion?  a condition report?  quoted text from a reply?
 *
 * in English, Russian, Uzbek (Latin + Cyrillic) and the mixed informal
 * trucking chat between them.
 *
 * The AI's answer is NEVER trusted blindly — canRegisterTrailerEvent (the hard
 * server-side gate) re-validates every field: exact intent, completed=true,
 * strict unit validation, real grounding in message/reply/image context, and
 * the confidence threshold. If the AI is unavailable, times out, or returns
 * invalid JSON, verification FAILS CLOSED: no status change, candidate goes to
 * review.
 *
 * No secrets and no full prompts are logged. Prompt size is bounded.
 */
const { callGeminiJson, GEMINI_API_KEY } = require('./geminiClient');
const { validateTrailerUnit, normalizeUnitCandidate } = require('./trailerUnitValidation');
const { groundedSourcesFromContext } = require('./trailerContextService');

// ── intent model ──
const INTENTS = new Set([
  'confirmed_pickup', 'confirmed_dropoff',
  'planned_pickup', 'planned_dropoff',
  'instruction_pickup', 'instruction_dropoff',
  'pickup_question', 'dropoff_question',
  'discussion', 'trailer_mention', 'condition_report_only', 'unclear',
]);
/** The ONLY intents that may ever change trailer status. */
const STATE_CHANGING_INTENTS = new Set(['confirmed_pickup', 'confirmed_dropoff']);

const UNIT_SOURCES = new Set([
  'current_text', 'current_caption', 'replied_text', 'replied_caption',
  'current_image', 'replied_image',
]);
const POSSESSION_VALUES = new Set(['with_driver', 'dropped', 'unknown']);
const CARGO_VALUES = new Set(['empty', 'loaded', 'unknown']);

// ── defaults (overridable via trailer_settings) ──
const DEFAULT_AUTO_REGISTER_CONFIDENCE = 92;
const DEFAULT_REVIEW_CONFIDENCE = 75;
const VERIFY_TIMEOUT_MS = 25_000;
const MAX_FIELD_CHARS = 400;

// In-flight de-dupe: one AI verification per Telegram message at a time.
const inFlight = new Map(); // key -> Promise

function isSemanticAiConfigured() {
  return Boolean(GEMINI_API_KEY);
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 1 && n >= 0) return Math.round(n * 100);
  return Math.max(0, Math.min(100, Math.round(n)));
}

function bounded(value, max = MAX_FIELD_CHARS) {
  if (value == null) return null;
  const t = String(value).trim();
  if (!t || t.toLowerCase() === 'null' || t.toLowerCase() === 'none') return null;
  return t.length > max ? t.slice(0, max) : t;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── prompt construction (bounded) ──

const SYSTEM_PROMPT =
  'You are a semantic verifier for a trucking company\'s trailer-responsibility ledger. '
  + 'Drivers report trailer pickups and drop-offs in Telegram groups, writing informally in '
  + 'ENGLISH, RUSSIAN, UZBEK (Latin script), UZBEK (Cyrillic script), and mixtures of these, '
  + 'with typos, slang, and transliteration.\n\n'
  + 'Your ONLY job: decide what the CURRENT SENDER actually means. You must distinguish:\n'
  + '- a COMPLETED past action ("picked up", "oldim", "olib oldim", "забрал", "подцепил", '
  + '"tashladim", "qoldirdim", "сбросил", "оставил") → confirmed_pickup / confirmed_dropoff\n'
  + '- a FUTURE PLAN by the sender ("I will pick it up", "olaman", "hozir olib boraman", '
  + '"я заберу", "заберу") → planned_pickup / planned_dropoff\n'
  + '- a COMMAND / INSTRUCTION to someone else ("pick up this trailer", "olasiz", "olib '
  + 'borasiz", "tashlaysiz", "забери", "возьмёшь этот трейлер") → instruction_pickup / '
  + 'instruction_dropoff. Uzbek verbs ending in -siz/-asiz ("olasiz", "tashlaysiz") address '
  + 'ANOTHER person and are instructions/future, NEVER completed actions by the sender.\n'
  + '- a QUESTION ("can you take it?", "olamizmi?", "можешь забрать?") → pickup_question / '
  + 'dropoff_question\n'
  + '- ordinary discussion, a bare trailer mention, or a condition-only report.\n\n'
  + 'Quoted/replied context: text quoted from a replied-to message shows what was discussed, '
  + 'NOT what the current sender did. Never assume the sender performed an action just '
  + 'because the quoted message contains action words.\n\n'
  + 'Trailer units: a unit is a real identifier like "SWFZ233611" or "403279". Generic words '
  + 'like "TRL", "TRAILER", "UNIT" are NEVER unit numbers. Only report a unit that literally '
  + 'appears in the provided context (message, reply, or image text), and quote the exact '
  + 'evidence. Facility/load/door numbers ("Load #9492869", "Home Depot MDO/DFC #5829", '
  + '"Door #25") are NOT trailer units.\n\n'
  + 'When one message covers SEVERAL trailers, judge each trailer independently — one '
  + 'sentence\'s action never applies to another sentence\'s trailer.\n\n'
  + 'Never invent facts. If unsure, use intent "unclear" and lower confidence. '
  + 'Respond with STRICT JSON only.';

function renderContextBlock(context) {
  const lines = [];
  const senderName = context?.sender?.name || context?.sender?.username || 'unknown';
  lines.push(`CURRENT MESSAGE (sender: ${senderName}):`);
  lines.push(`"""${bounded(context?.messageText, 800) || '(photo with no caption)'}"""`);

  if (context?.repliedMessage) {
    const r = context.repliedMessage;
    const rSender = r.sender?.name || r.sender?.username || 'unknown';
    lines.push('');
    lines.push(`REPLIED-TO MESSAGE (sender: ${rSender}${r.hasPhoto ? ', contains a photo' : ''}):`);
    const rText = bounded(r.text || r.caption, 600);
    lines.push(`"""${rText || (r.hasPhoto ? '(photo with no caption)' : '(empty)')}"""`);
  }

  const repliedUnits = context?.repliedImage?.trailerUnits || [];
  if (repliedUnits.length || context?.repliedImage?.visibleText) {
    lines.push('');
    lines.push('TEXT EXTRACTED FROM THE REPLIED-TO IMAGE:');
    for (const u of repliedUnits) lines.push(`- unit ${u.value} (evidence: "${u.exactEvidence}")`);
    if (context.repliedImage.visibleText) lines.push(`- other visible text: ${bounded(context.repliedImage.visibleText, 300)}`);
  }
  const currentUnits = context?.currentImage?.trailerUnits || [];
  if (currentUnits.length || context?.currentImage?.visibleText) {
    lines.push('');
    lines.push('TEXT EXTRACTED FROM THE CURRENT MESSAGE\'S IMAGE:');
    for (const u of currentUnits) lines.push(`- unit ${u.value} (evidence: "${u.exactEvidence}")`);
    if (context.currentImage.visibleText) lines.push(`- other visible text: ${bounded(context.currentImage.visibleText, 300)}`);
  }

  if (Array.isArray(context?.recentMessages) && context.recentMessages.length) {
    lines.push('');
    lines.push('RECENT GROUP MESSAGES (oldest first, for context only):');
    for (const m of context.recentMessages.slice(-5)) {
      lines.push(`${m.sender}: ${bounded(m.text, 200)}`);
    }
  }

  if (Array.isArray(context?.candidateUnits) && context.candidateUnits.length) {
    lines.push('');
    lines.push('CANDIDATE TRAILER UNITS FOUND IN CONTEXT:');
    for (const c of context.candidateUnits.slice(0, 8)) {
      lines.push(`- ${c.value} (from ${c.source})`);
    }
  }

  if (Array.isArray(context?.existingTrailerStates) && context.existingTrailerStates.length) {
    lines.push('');
    lines.push('CURRENT KNOWN TRAILER STATES:');
    for (const st of context.existingTrailerStates.slice(0, 8)) {
      lines.push(`- ${st.unit}: possession=${st.possessionStatus}, cargo=${st.cargoStatus}, last=${st.lastEventType || '—'}`);
    }
  }
  return lines.join('\n');
}

function renderDeterministicBlock(deterministicResults) {
  const list = Array.isArray(deterministicResults) ? deterministicResults : [deterministicResults].filter(Boolean);
  if (!list.length) return '';
  const lines = ['', 'DETERMINISTIC PARSER GUESS (regex-based; may be wrong about tense/person — verify it):'];
  for (const d of list.slice(0, 6)) {
    lines.push(`- unit=${d.trailerUnit || '—'} action=${d.action || '—'} location=${d.locationText || '—'} condition=${d.conditionText || '—'}`);
  }
  return lines.join('\n');
}

const RESPONSE_SCHEMA =
  'Return JSON with EXACTLY these keys:\n'
  + '{\n'
  + '  "trailerRelated": boolean,\n'
  + '  "intent": "confirmed_pickup" | "confirmed_dropoff" | "planned_pickup" | "planned_dropoff" '
  + '| "instruction_pickup" | "instruction_dropoff" | "pickup_question" | "dropoff_question" '
  + '| "discussion" | "trailer_mention" | "condition_report_only" | "unclear",\n'
  + '  "action": "pickup" | "dropoff" | null,\n'
  + '  "completed": boolean,          // true ONLY when the sender states the action ALREADY happened\n'
  + '  "trailerEvents": [\n'
  + '    {\n'
  + '      "trailerUnit": string | null,   // exactly as it appears in the context; null if none\n'
  + '      "intent": string,               // per-trailer intent (same vocabulary)\n'
  + '      "action": "pickup" | "dropoff" | null,\n'
  + '      "completed": boolean,           // per-trailer: already done?\n'
  + '      "unitGrounded": boolean,        // the unit literally appears in the provided context\n'
  + '      "unitSource": "current_text" | "current_caption" | "replied_text" | "replied_caption" | "current_image" | "replied_image" | null,\n'
  + '      "unitEvidence": string | null,  // exact text the unit came from\n'
  + '      "possessionStatus": "with_driver" | "dropped" | "unknown",\n'
  + '      "cargoStatus": "empty" | "loaded" | "unknown",\n'
  + '      "locationText": string | null,\n'
  + '      "conditionText": string | null,\n'
  + '      "actionEvidence": string | null, // exact words expressing the action\n'
  + '      "confidence": number,            // 0..100 for THIS trailer\'s classification\n'
  + '      "reason": string                 // one short sentence\n'
  + '    }\n'
  + '  ],\n'
  + '  "language": string | null,        // e.g. "uz", "ru", "en", "uz-Cyrl", "mixed"\n'
  + '  "needsReview": boolean\n'
  + '}';

// ── result normalization / validation ──

/**
 * Normalize + sanitize the raw AI JSON into a trusted internal shape. Every
 * unit is re-validated and re-grounded server-side: an event whose unit fails
 * strict validation keeps the event but with unitGrounded forced to false (the
 * approval gate will refuse it). Returns null for structurally invalid output.
 */
function normalizeAiResult(parsed, context) {
  if (!parsed || typeof parsed !== 'object') return null;
  const intent = INTENTS.has(String(parsed.intent)) ? String(parsed.intent) : null;
  if (!intent) return null;
  if (!Array.isArray(parsed.trailerEvents)) return null;

  const grounded = groundedSourcesFromContext(context || {});
  const events = [];
  for (let i = 0; i < parsed.trailerEvents.length && i < 6; i += 1) {
    const raw = parsed.trailerEvents[i] || {};
    const unit = normalizeUnitCandidate(raw.trailerUnit);
    const validation = unit ? validateTrailerUnit(unit, grounded) : { valid: false, reason: 'no unit', source: null };
    const evIntent = INTENTS.has(String(raw.intent)) ? String(raw.intent) : intent;
    const action = raw.action === 'pickup' || raw.action === 'dropoff' ? raw.action : null;
    events.push({
      eventIndex: i,
      trailerUnit: unit,
      intent: evIntent,
      action,
      completed: raw.completed === true,
      // Server-side grounding wins over whatever the AI claimed.
      unitGrounded: validation.valid,
      unitSource: validation.valid
        ? (UNIT_SOURCES.has(String(raw.unitSource)) ? String(raw.unitSource) : validation.source)
        : null,
      unitEvidence: bounded(raw.unitEvidence),
      unitValidationReason: validation.reason,
      possessionStatus: POSSESSION_VALUES.has(String(raw.possessionStatus)) ? String(raw.possessionStatus) : 'unknown',
      cargoStatus: CARGO_VALUES.has(String(raw.cargoStatus)) ? String(raw.cargoStatus) : 'unknown',
      locationText: bounded(raw.locationText),
      conditionText: bounded(raw.conditionText),
      actionEvidence: bounded(raw.actionEvidence),
      confidence: clampConfidence(raw.confidence),
      reason: bounded(raw.reason) || '',
    });
  }

  return {
    trailerRelated: parsed.trailerRelated === true,
    intent,
    action: parsed.action === 'pickup' || parsed.action === 'dropoff' ? parsed.action : null,
    completed: parsed.completed === true,
    trailerEvents: events,
    language: bounded(parsed.language, 20),
    needsReview: parsed.needsReview === true,
    status: 'ok',
  };
}

/**
 * Run the mandatory semantic verification for one message. Returns:
 *   { status:'ok', …normalized result…, aiModel }
 *   { status:'unavailable' }         — AI not configured
 *   { status:'error', error }        — network/timeout/exhausted models
 *   { status:'invalid_response' }    — AI answered but JSON was unusable
 *
 * Callers MUST fail closed on any non-'ok' status. Never throws.
 */
async function verifyTrailerSemantics(context, deterministicResults, opts = {}) {
  if (!isSemanticAiConfigured()) return { status: 'unavailable' };

  const dedupeKey = opts.dedupeKey || null;
  if (dedupeKey && inFlight.has(dedupeKey)) return inFlight.get(dedupeKey);

  const run = (async () => {
    try {
      const userText =
        `${renderContextBlock(context)}${renderDeterministicBlock(deterministicResults)}\n\n${RESPONSE_SCHEMA}`;
      const { parsed, model } = await withTimeout(
        callGeminiJson({
          systemText: SYSTEM_PROMPT,
          userText,
          maxOutputTokens: 1200,
          maxRetryWaitMs: 5_000,
          validateParsed: (p) => p && typeof p === 'object'
            && INTENTS.has(String(p.intent)) && Array.isArray(p.trailerEvents),
        }),
        opts.timeoutMs || VERIFY_TIMEOUT_MS,
        'trailer semantic verification'
      );
      const normalized = normalizeAiResult(parsed, context);
      if (!normalized) return { status: 'invalid_response' };
      normalized.aiModel = model || null;
      return normalized;
    } catch (err) {
      console.warn('[TRAILER-SEMANTIC] verification failed (fail closed):', err.message);
      return { status: 'error', error: err.message };
    }
  })();

  if (dedupeKey) {
    inFlight.set(dedupeKey, run);
    run.finally(() => inFlight.delete(dedupeKey)).catch(() => {});
  }
  return run;
}

// ── hard server-side approval gate ──

/**
 * Resolve thresholds from trailer settings (falls back to defaults).
 */
function resolveThresholds(settings = {}) {
  const auto = Number(settings.auto_register_confidence);
  const review = Number(settings.review_confidence);
  return {
    autoRegister: Number.isFinite(auto) && auto >= 50 && auto <= 100 ? auto : DEFAULT_AUTO_REGISTER_CONFIDENCE,
    review: Number.isFinite(review) && review >= 0 && review <= 100 ? review : DEFAULT_REVIEW_CONFIDENCE,
  };
}

/**
 * THE hard approval gate. Pure function — no IO. Returns
 *   { allow: boolean, disposition: 'register'|'review'|'ignore', reason }
 *
 * `aiResult` is the normalized verifier output; `event` is one of its
 * trailerEvents; `groundedContext` is the collected message context;
 * `settings` supplies the thresholds.
 */
function evaluateTrailerEventApproval(aiResult, event, groundedContext, settings = {}) {
  const t = resolveThresholds(settings);
  const deny = (reason, disposition = 'review') => ({ allow: false, disposition, reason });

  if (!aiResult || aiResult.status !== 'ok') {
    return deny(`AI verification ${aiResult?.status || 'missing'} — fail closed`);
  }
  if (!event) return deny('no event');

  const intent = event.intent || aiResult.intent;
  // 1. Only confirmed intents may change state; everything else is at most a
  //    review item (questions/discussion are silently ignorable).
  if (!STATE_CHANGING_INTENTS.has(intent)) {
    const quiet = ['discussion', 'trailer_mention', 'pickup_question', 'dropoff_question', 'condition_report_only'];
    return deny(`intent ${intent} never changes state`, quiet.includes(intent) ? 'ignore' : 'review');
  }
  // 2. Completed must be explicitly true (per-event AND top-level not contradicting).
  if (event.completed !== true) return deny('event not marked completed');
  if (aiResult.completed !== true && aiResult.trailerEvents.length === 1) {
    return deny('message-level completed=false contradicts event');
  }
  // 3. Action must match the intent.
  const expectedAction = intent === 'confirmed_pickup' ? 'pickup' : 'dropoff';
  if (event.action !== expectedAction) return deny(`action ${event.action} does not match ${intent}`);
  // 4+5+6. Strict unit validation + grounding (unitGrounded was already forced
  // server-side in normalizeAiResult, but re-check from primary sources).
  if (!event.trailerUnit) return deny('no trailer unit');
  const grounded = groundedSourcesFromContext(groundedContext || {});
  const validation = validateTrailerUnit(event.trailerUnit, grounded);
  if (!validation.valid) return deny(`unit ${event.trailerUnit} invalid: ${validation.reason}`);
  if (event.unitGrounded !== true) return deny('unit not grounded');
  // 7. Confidence thresholds.
  if (event.confidence < t.review) return deny(`confidence ${event.confidence} below review threshold ${t.review}`, 'ignore');
  if (event.confidence < t.autoRegister) {
    return deny(`confidence ${event.confidence} below auto-register threshold ${t.autoRegister}`);
  }
  // 8. No contradictory review flag from the AI itself.
  if (aiResult.needsReview === true) return deny('AI flagged needsReview');
  // 9. The message-level intent must not be primarily a question/instruction
  //    when this is the only event.
  if (aiResult.trailerEvents.length === 1 && !STATE_CHANGING_INTENTS.has(aiResult.intent)) {
    return deny(`message intent ${aiResult.intent} is not a confirmation`);
  }

  return { allow: true, disposition: 'register', reason: 'confirmed completed action with grounded unit' };
}

/** Boolean façade over evaluateTrailerEventApproval (the spec's shape). */
function canRegisterTrailerEvent(aiResult, event, groundedContext, settings = {}) {
  return evaluateTrailerEventApproval(aiResult, event, groundedContext, settings).allow === true;
}

module.exports = {
  verifyTrailerSemantics,
  normalizeAiResult,
  evaluateTrailerEventApproval,
  canRegisterTrailerEvent,
  resolveThresholds,
  isSemanticAiConfigured,
  INTENTS,
  STATE_CHANGING_INTENTS,
  DEFAULT_AUTO_REGISTER_CONFIDENCE,
  DEFAULT_REVIEW_CONFIDENCE,
  VERIFY_TIMEOUT_MS,
  // exported for tests
  renderContextBlock,
  SYSTEM_PROMPT,
};
