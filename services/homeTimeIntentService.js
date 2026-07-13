/**
 * Home-Time intent classifier.
 *
 * A single AI pass that reads one driver-group message (plus a little context)
 * and decides what it MEANS for home time. It distinguishes an ACTUAL state
 * change ("Status: Home", "uyda", "домой приехал") from a mere PLAN or REQUEST
 * ("I may go home next week", "can he get home time?"), and extracts any dates.
 *
 * Cost control (section 15): never call the AI on ordinary chatter. A cheap
 * multi-language candidate filter runs first; only messages that plausibly touch
 * home/road status, a home-time request/plan, or an open clarification reach the
 * model. Reuses the shared Gemini client — no separate AI provider.
 *
 * Everything the AI returns is validated and normalized server-side through the
 * pure homeTimeDateResolver; the AI never writes status or dates directly.
 */
const { DateTime } = require('luxon');
const { callGeminiJson } = require('./geminiClient');
const { parseDriverStatus } = require('./homeTimeConstants');
const {
  hasHomeTimeSignal, parseHomeTimeWindowText, looksLikeDateReply,
} = require('./homeTimeRequestConstants');
const { normalizeHomeTimeWindow, TZ } = require('./homeTimeDateResolver');

const VALID_INTENTS = [
  'actual_home_status', 'actual_road_status', 'home_time_request',
  'home_time_followup', 'planned_home_status', 'question_or_discussion', 'unrelated',
];

// Multi-language hints (en / ru / uz-latin / uz-cyrillic) that a message is ABOUT
// home or road status/plans. Deliberately broad — this is a candidate gate, not a
// decision; the AI makes the actual call. Kept lowercase-tested.
// Cyrillic / Uzbek entries deliberately omit \b — JS word boundaries are
// ASCII-only and would never fire before a Cyrillic letter.
const HOME_HINTS = [
  /\bhome\b/i, /\bhouse\b/i, /\bvacation\b/i, /\bpto\b/i, /\btime\s*off\b/i,
  /\bday(?:s)?\s*off\b/i, /\buyda\b/i, /\buyga\b/i, /дом(?:ой|а|у)/i,
  /приехал/i, /отдых/i,
];
const ROAD_HINTS = [
  /\bready\b/i, /\brolling\b/i, /\broll\b/i, /\bon\s+the\s+road\b/i, /\bback\s+on\b/i,
  /\byo'?lda\b/i, /\byo'?lga\b/i, /в\s*пути/i, /выехал/i, /готов/i,
];

/**
 * Cheap pre-filter: does this message plausibly relate to home-time status, a
 * request/plan, or an in-progress clarification? Keeps the AI off ordinary chat.
 */
function isHomeTimeCandidate(text, { hasOpenClarification = false, mentionsApprover = false } = {}) {
  const str = String(text || '');
  if (!str.trim()) return false;
  if (mentionsApprover) return true;
  if (parseDriverStatus(str)) return true;
  if (hasHomeTimeSignal(str)) return true;
  if (HOME_HINTS.some((re) => re.test(str))) return true;
  if (ROAD_HINTS.some((re) => re.test(str))) return true;
  // While a clarification is open, a plain date-looking reply is a candidate.
  if (hasOpenClarification && looksLikeDateReply(str)) return true;
  return false;
}

/**
 * Build the classifier prompt. Pure (no network) so it is unit-testable. The
 * triggering message is shown separately from the rolling transcript because the
 * trigger carries the intent while the transcript supplies context.
 */
function buildIntentPrompt({
  transcript, triggerText, todayLabel, senderIsDriver, openQuestion,
  knownHomeStart, knownReturnToRoad,
} = {}) {
  const today = todayLabel || DateTime.now().setZone(TZ).toISODate();
  const lines = [
    'You classify ONE message from a US trucking company driver group on Telegram for a home-time tracker.',
    `Today is ${today} (America/Chicago). Resolve relative dates ("tomorrow", "next Monday", "juma", "в понедельник") against it.`,
    '',
    'Pick exactly ONE intent:',
    '- actual_home_status: the driver IS physically home NOW (e.g. "Status: Home", "he is home", "uyda", "домой приехал", "at the house").',
    '- actual_road_status: the driver is back ON THE ROAD NOW (e.g. "Status: Ready", "rolling", "yo\'lda", "выехал").',
    '- home_time_request: asking to GO home / take time off in the future (may include dates).',
    '- home_time_followup: answering a pending question about home-time DATES.',
    '- planned_home_status: a future plan/intention, NOT a request and NOT current ("I may go home next week", "almost home", "he wants to be home Monday").',
    '- question_or_discussion: talking about home time but not requesting/reporting (e.g. "can I go home?", "when can he get home time?").',
    '- unrelated: anything else.',
    '',
    'CRITICAL: a plan or a question is NOT an actual status change. Only set isActualStatusChange=true when the message reports the driver IS home now or IS back on the road now.',
    '',
    'Also extract any home-time dates the message states:',
    '- homeStartDate: the day the driver arrives/arrived home.',
    '- returnToRoadDate: the day the driver leaves home to go back on the road.',
    '- lastDayHome: the final day at home, if stated as a range end ("Monday through Thursday" → Thursday).',
    '- durationDays: a stated length ("for 4 days").',
    'Only fill a field the message actually supports. Never guess. If only one endpoint is given, leave the other null.',
  ];
  if (openQuestion) {
    lines.push('', `A clarification is OPEN. The exact question awaiting an answer is: "${String(openQuestion).slice(0, 300)}"`);
  }
  if (knownHomeStart) lines.push(`Already known home-start date: ${knownHomeStart}.`);
  if (knownReturnToRoad) lines.push(`Already known return-to-road date: ${knownReturnToRoad}.`);
  if (senderIsDriver != null) {
    lines.push(`The sender ${senderIsDriver ? 'IS' : 'is NOT'} the driver of this group.`);
  }
  lines.push(
    '',
    'Message to classify:',
    `"""\n${String(triggerText || '(unavailable)').slice(0, 800)}\n"""`,
    '',
    'Recent conversation for context (oldest first):',
    `"""\n${transcript || '(no recent messages)'}\n"""`,
    '',
    'Respond with JSON only:',
    '{"intent":"actual_home_status|actual_road_status|home_time_request|home_time_followup|planned_home_status|question_or_discussion|unrelated",'
      + '"confidence":0-100,"isActualStatusChange":true|false,"requestedHomeTime":true|false,'
      + '"homeStartDate":"YYYY-MM-DD|null","returnToRoadDate":"YYYY-MM-DD|null","lastDayHome":"YYYY-MM-DD|null",'
      + '"durationDays":number|null,"language":"en|ru|uz|mixed","evidence":["exact phrase"],"reason":"<short>"}'
  );
  return lines.join('\n');
}

function normalizeIntent(value) {
  const v = String(value || '').toLowerCase().trim();
  return VALID_INTENTS.includes(v) ? v : 'unrelated';
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Deterministic fallback when the AI is unavailable. Uses the exact-status parser
 * and home-time wording detector so an outage neither drops a real signal nor
 * invents one. Ambiguous text stays 'unrelated' (no state change).
 */
function classifyDeterministically({ triggerText, transcript, todayIso, hasOpenClarification }) {
  const text = String(triggerText || '');
  const haystack = `${text}\n${transcript || ''}`;
  const status = parseDriverStatus(text);
  const window = parseHomeTimeWindowText(haystack, todayIso) || {};

  if (status === 'home') {
    return {
      intent: 'actual_home_status', isActualStatusChange: true, requestedHomeTime: false,
      raw: {}, confidence: null,
      reason: 'AI unavailable — exact "Status: Home" detected.',
    };
  }
  if (status === 'road') {
    return {
      intent: 'actual_road_status', isActualStatusChange: true, requestedHomeTime: false,
      raw: {}, confidence: null,
      reason: 'AI unavailable — exact "Status: Ready/Rolling" detected.',
    };
  }
  if (hasHomeTimeSignal(haystack)) {
    return {
      intent: 'home_time_request', isActualStatusChange: false, requestedHomeTime: true,
      raw: { homeStart: window.homeFrom, lastDayHome: window.homeTo }, confidence: null,
      reason: 'AI unavailable — home-time wording detected.',
    };
  }
  if (hasOpenClarification && looksLikeDateReply(text)) {
    return {
      intent: 'home_time_followup', isActualStatusChange: false, requestedHomeTime: false,
      raw: { homeStart: window.homeFrom, lastDayHome: window.homeTo }, confidence: null,
      reason: 'AI unavailable — date-looking reply to an open clarification.',
    };
  }
  return {
    intent: 'unrelated', isActualStatusChange: false, requestedHomeTime: false,
    raw: {}, confidence: null, reason: 'AI unavailable — no home-time signal.',
  };
}

/**
 * Classify one message. Returns a normalized verdict with a resolved date window
 * (merging any known context). Never throws.
 *
 * @returns {{ intent:string, confidence:(number|null), isActualStatusChange:boolean,
 *   requestedHomeTime:boolean, window:object, language:(string|null),
 *   evidence:string[], reason:string, aiUsed:boolean }}
 */
async function classifyHomeTimeMessage(input = {}) {
  const {
    transcript = '', triggerText = '', todayIso = null, senderIsDriver = null,
    hasOpenClarification = false, openQuestion = null,
    knownHomeStart = null, knownReturnToRoad = null,
  } = input;
  const today = todayIso || DateTime.now().setZone(TZ).toISODate();

  const finalize = (base, raw) => {
    const window = normalizeHomeTimeWindow({
      homeStart: raw.homeStart ?? raw.homeStartDate ?? null,
      returnToRoad: raw.returnToRoad ?? raw.returnToRoadDate ?? null,
      lastDayHome: raw.lastDayHome ?? null,
      durationDays: raw.durationDays ?? null,
      knownHomeStart,
      knownReturnToRoad,
    });
    return {
      intent: base.intent,
      confidence: base.confidence ?? null,
      isActualStatusChange: Boolean(base.isActualStatusChange),
      requestedHomeTime: Boolean(base.requestedHomeTime),
      window,
      language: base.language || null,
      evidence: Array.isArray(base.evidence) ? base.evidence.slice(0, 5) : [],
      reason: String(base.reason || '').slice(0, 300),
      aiUsed: Boolean(base.aiUsed),
    };
  };

  const prompt = buildIntentPrompt({
    transcript, triggerText, todayLabel: today, senderIsDriver, openQuestion,
    knownHomeStart, knownReturnToRoad,
  });

  try {
    const { parsed } = await callGeminiJson({
      userText: prompt,
      maxOutputTokens: 320,
      validateParsed: (p) => typeof p?.intent === 'string',
    });
    const intent = normalizeIntent(parsed.intent);
    // Server-side guardrail: a plan or a question is never an actual state change,
    // regardless of what the model set.
    const isActual = Boolean(parsed.isActualStatusChange)
      && (intent === 'actual_home_status' || intent === 'actual_road_status');
    return finalize({
      intent,
      confidence: clampConfidence(parsed.confidence),
      isActualStatusChange: isActual,
      requestedHomeTime: Boolean(parsed.requestedHomeTime),
      language: parsed.language,
      evidence: parsed.evidence,
      reason: parsed.reason,
      aiUsed: true,
    }, {
      homeStartDate: parsed.homeStartDate,
      returnToRoadDate: parsed.returnToRoadDate,
      lastDayHome: parsed.lastDayHome,
      durationDays: parsed.durationDays,
    });
  } catch (err) {
    console.warn('[HOME-TIME-INTENT] AI classification failed, using deterministic fallback:', err.message);
    const det = classifyDeterministically({ triggerText, transcript, todayIso: today, hasOpenClarification });
    return finalize({ ...det, aiUsed: false }, det.raw);
  }
}

module.exports = {
  VALID_INTENTS,
  isHomeTimeCandidate,
  buildIntentPrompt,
  classifyHomeTimeMessage,
  classifyDeterministically,
};
