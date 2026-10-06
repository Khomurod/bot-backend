/**
 * A second opinion on a load alarm, before it reaches the chat. PURE.
 *
 * The rules in `lib/loads/lifecycle.js` call a disagreement between Datatruck
 * and the truck's position when positive evidence contradicts the board. They
 * are right most of the time and still produce alarms nobody acts on — a GPS
 * point that is stale by minutes, coordinates that are close to but not quite
 * the stop. The owner asked that only real ones reach the chat.
 *
 * WHAT THE MODEL MAY DO: say whether the facts look like a real problem or
 * like bad data, in one sentence. That is all. It never changes a load's
 * phase, never files or resolves a finding, and is never shown a driver's
 * name, an address or a coordinate — only the same distances, speeds and
 * statuses a dispatcher would read off the screen.
 *
 * WHAT IT CAN CHANGE: whether the CHAT is told. A "looks like bad data" answer
 * keeps the notice out of the chat; the finding still sits on Needs Attention
 * with the model's sentence beside it. Only a confident answer holds a notice
 * back, and anything else — unsure, unavailable, malformed — sends it exactly
 * as it would have been sent without AI.
 */
const { describeConflict } = require('./lifecycle');

const VERDICTS = Object.freeze(['real_problem', 'likely_bad_data', 'unsure']);
/** Below this, "likely bad data" is not enough to keep a notice out of the chat. */
const HOLD_CONFIDENCE = 80;
const MAX_WHY = 200;

/** The facts, and only the facts. No name, no address, no coordinate. */
function buildReviewPrompt(verdict) {
  const f = verdict.facts || {};
  const line = (label, value) => (value == null ? null : `- ${label}: ${value}`);
  return [
    'You check alarms for a trucking company operations chat. An automatic rule found that',
    'the load board (Datatruck) disagrees with where the truck actually is. Decide whether',
    'this looks like a REAL operational problem a dispatcher must act on, or LIKELY BAD DATA',
    '(stale or imprecise GPS, a stop pinned in the wrong place, a board status nobody updated).',
    '',
    'What the rule found:',
    ...verdict.conflicts.map((c) => `- ${describeConflict(c)}`),
    '',
    'The facts:',
    line('Board status', f.boardStatus),
    line('Phase from the truck position', verdict.phase),
    line('Miles from the pickup', f.milesToPickup),
    line('Miles from the delivery', f.milesToDelivery),
    line('Truck moving', f.moving === true ? 'yes' : (f.moving === false ? 'no' : null)),
    line('GPS age in minutes', f.gpsAgeMinutes),
    line('Seen at the pickup before', f.sawPickup === true ? 'yes' : 'no'),
    line('Seen at the delivery before', f.sawDelivery === true ? 'yes' : 'no'),
    '',
    'Answer with JSON only: {"verdict": "real_problem" | "likely_bad_data" | "unsure",',
    '"confidence": 0-100, "why": "one short sentence a dispatcher understands"}.',
    'Say "unsure" when the facts do not settle it. Do not invent facts.',
  ].filter((l) => l !== null).join('\n');
}

/** The router's validator: the shape, nothing more. */
function validateReview(_raw, parsed) {
  if (!parsed || typeof parsed !== 'object') return { message: 'not a JSON object' };
  if (!VERDICTS.includes(parsed.verdict)) return { message: 'unknown verdict' };
  const c = Number(parsed.confidence);
  if (!Number.isFinite(c) || c < 0 || c > 100) return { message: 'confidence out of range' };
  if (typeof parsed.why !== 'string' || !parsed.why.trim()) return { message: 'no reason given' };
  return true;
}

/**
 * What to do with the notice, given the review (or its absence).
 *
 * @param {object|null} review  a validated `{verdict, confidence, why}`, or null
 * @returns {{send:boolean, line:string|null, review:object|null}}
 */
function decideFromReview(review) {
  if (!review || validateReview(null, review) !== true) return { send: true, line: null, review: null };
  const why = String(review.why).replace(/\s+/g, ' ').trim().slice(0, MAX_WHY);
  const clean = { verdict: review.verdict, confidence: Number(review.confidence), why };
  if (clean.verdict === 'likely_bad_data' && clean.confidence >= HOLD_CONFIDENCE) {
    return { send: false, line: null, review: clean };
  }
  return { send: true, line: `Wenze's read: ${why}`, review: clean };
}

module.exports = {
  VERDICTS, HOLD_CONFIDENCE, buildReviewPrompt, validateReview, decideFromReview,
};
