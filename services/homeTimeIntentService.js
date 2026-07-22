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
  parseHomeTimeWindowText, looksLikeDateReply,
} = require('./homeTimeRequestConstants');
const {
  hasHomeTimeSignal, hasStrongHomeTimeSignal, looksLikeTemporaryHomeStop,
} = require('./homeTimeSignals');
const { normalizeHomeTimeWindow, TZ } = require('./homeTimeDateResolver');

// A driver-initiated "home_time_request" verdict is only ACTED ON (a clarification
// is opened / a card is posted) when the AI is at least this confident OR the
// message carries corroborating strong wording / an explicit date. This is what
// stops a low-confidence guess on an incidental "home" mention from opening a
// request. Actual status changes keep their own, separate confidence gate in the
// request service.
const REQUEST_CONFIDENCE_MIN = 60;

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
    'Judge the MEANING and INTENTION of the message, not the mere presence of the words "home" or "house".',
    'A message that only mentions a home, house, family, or hometown is NOT a home-time request.',
    'The following are NOT home-time requests — do NOT open one, and do NOT ask about arrive-home or',
    'return-to-road dates:',
    '- A brief stop or errand: "pass by his house", "swing by home", "stop by the house".',
    '- Picking up or dropping off something/someone: clothes, belongings, documents, medicine, equipment,',
    '  a package, or a person ("drop him off at home").',
    "- Passing THROUGH the driver's hometown or area while continuing the current trip.",
    '- Sleeping at home ONE night because the route passes nearby ("home for the night").',
    "- A pickup, delivery, repair, oil change, or appointment located near the driver's home.",
    '- Progress / incidental use ("almost home", "heading home for the night", "home at the yard/terminal",',
    '  "Home Depot", "home 20 miles out"), a greeting, or just discussing someone\'s house.',
    'Concrete example that is NOT a request: "Please talk to the driver. He needs to pass by his house to',
    'pick up his personal belongings." He is only making a short stop and keeps working → answer unrelated.',
    '',
    'It IS a home_time_request only when the driver — or a rep on the driver\'s behalf — is actually asking',
    'to TAKE TIME OFF or be home for a period: staying home for several days, days off, vacation/PTO, being',
    'routed home for a break, or giving arrive-home / back-on-the-road dates. Informal phrasing still counts',
    '("he\'s been out 6 weeks and wants a few days with his family").',
    '',
    'Base your decision on the MESSAGE TO CLASSIFY below. Use the recent conversation only when it is clearly',
    'part of the same, still-open request; an earlier, resolved, or unrelated home-time discussion must NOT',
    'turn this message into a request. A manager being tagged does NOT by itself make it a request — managers',
    'are tagged for loads, rates, breakdowns, paperwork, and many other reasons. When the meaning is unclear,',
    'prefer question_or_discussion or unrelated with a LOW confidence; never guess a request.',
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
 * Precision guard for a driver-initiated request. The candidate gate is broad
 * (any "home" reaches the model), so a low-confidence AI "home_time_request" on
 * an incidental mention must NOT open a request. We act on such a verdict only
 * when the model is reasonably confident OR the message itself carries strong
 * time-off wording / an explicit date. Otherwise the request intent is dropped
 * (downgraded to question_or_discussion) while every extracted date is kept, so
 * a genuine follow-up during an open clarification is unaffected. Never touches
 * actual-status verdicts.
 */
function applyRequestPrecisionGuard(verdict, { triggerText = '' } = {}) {
  const requested = verdict.requestedHomeTime || verdict.intent === 'home_time_request';
  if (!requested) return verdict;
  const hasDate = Boolean(verdict.window
    && (verdict.window.homeStartDate || verdict.window.returnToRoadDate));

  // A brief stop / errand near home is never a request — no matter how confident
  // the model is. This is the "pass by the house to grab belongings" family: the
  // meaning of the text does not support real home time, so we do not rely on AI
  // confidence alone. Any extracted dates stay on the verdict.
  if (looksLikeTemporaryHomeStop(triggerText, { hasDate })) {
    return downgradeRequestVerdict(verdict,
      'Precision guard: temporary stop / errand near home (no time-off wording or date) '
      + '— not treated as a request.');
  }

  const corroborated = hasStrongHomeTimeSignal(triggerText) || hasDate;
  const confident = verdict.confidence == null
    ? corroborated
    : (verdict.confidence >= REQUEST_CONFIDENCE_MIN || corroborated);
  if (confident) return verdict;
  return downgradeRequestVerdict(verdict,
    `Precision guard: low-confidence home mention (conf ${verdict.confidence ?? 'n/a'}, `
    + 'no strong wording/date) — not treated as a request.');
}

/**
 * Drop a request verdict to plain discussion while KEEPING any extracted dates and
 * the rest of the verdict. Used by the precision guard so an incidental "home"
 * mention or an errand never opens a request.
 */
function downgradeRequestVerdict(verdict, why) {
  return {
    ...verdict,
    intent: verdict.intent === 'home_time_request' ? 'question_or_discussion' : verdict.intent,
    requestedHomeTime: false,
    reason: `${why} ${verdict.reason || ''}`.slice(0, 300),
  };
}

/**
 * Deterministic fallback when the AI is unavailable. Uses the exact-status parser
 * and the STRICT time-off wording detector so an outage neither drops a clear
 * signal nor invents one: only unambiguous wording ("PTO", "days off", "home for
 * a week") opens a request, while ambiguous "home" chatter stays 'unrelated'.
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
  // Strong time-off wording opens a request when the AI is down — UNLESS the same
  // text is really a brief stop / errand near home ("go home to grab his stuff"),
  // in which case we stay conservative and do not fabricate a request.
  const hasWindowDate = Boolean(window.homeFrom || window.homeTo);
  if (hasStrongHomeTimeSignal(haystack)
    && !looksLikeTemporaryHomeStop(haystack, { hasDate: hasWindowDate })) {
    return {
      intent: 'home_time_request', isActualStatusChange: false, requestedHomeTime: true,
      raw: { homeStart: window.homeFrom, lastDayHome: window.homeTo }, confidence: null,
      reason: 'AI unavailable — explicit time-off wording detected.',
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
    const verdict = finalize({
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
    return applyRequestPrecisionGuard(verdict, { triggerText });
  } catch (err) {
    console.warn('[HOME-TIME-INTENT] AI classification failed, using deterministic fallback:', err.message);
    const det = classifyDeterministically({ triggerText, transcript, todayIso: today, hasOpenClarification });
    return finalize({ ...det, aiUsed: false }, det.raw);
  }
}

module.exports = {
  VALID_INTENTS,
  REQUEST_CONFIDENCE_MIN,
  isHomeTimeCandidate,
  buildIntentPrompt,
  classifyHomeTimeMessage,
  classifyDeterministically,
  applyRequestPrecisionGuard,
};
