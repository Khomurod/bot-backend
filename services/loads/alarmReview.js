/**
 * Asking the AI for a second opinion on a load alarm (`load_alarm_review`).
 *
 * The rule and its limits are in `lib/loads/alarmReview.js`. This is only the
 * call and a memory: one review per load, per disagreement, per day — a held
 * notice is re-derived every ten minutes, and asking again each time would
 * spend a provider's quota on a question already answered.
 *
 * NEVER THROWS, AND NEVER HOLDS A NOTICE BY FAILING. No provider, the
 * capability switched off, a malformed answer: the notice goes out exactly as
 * it would have without AI.
 */
const {
  buildReviewPrompt, validateReview, decideFromReview,
} = require('../../lib/loads/alarmReview');

const CAPABILITY = 'load_alarm_review';
const MAX_REMEMBERED = 500;
const remembered = new Map();

function defaultDeps() {
  /* eslint-disable global-require */
  return { runCapability: require('../ai/router').runCapability };
  /* eslint-enable global-require */
}

function keyFor(out, nowIso) {
  return `${out.state.orderId}|${String(nowIso).slice(0, 10)}|${out.verdict.conflicts.join(',')}`;
}

/** @returns {Promise<{send:boolean, line:string|null, review:object|null}>} */
async function reviewLoadAlarm(out, nowIso, deps = defaultDeps()) {
  const key = keyFor(out, nowIso);
  if (remembered.has(key)) return remembered.get(key);
  let decision;
  try {
    const { parsed } = await deps.runCapability({
      capability: CAPABILITY,
      userText: buildReviewPrompt(out.verdict),
      expects: 'json',
      validate: validateReview,
    });
    decision = decideFromReview(parsed);
  } catch (_) {
    // Unavailable, switched off, or every provider refused: say it as before,
    // and do not remember it — the next pass may have a provider again.
    return decideFromReview(null);
  }
  if (remembered.size >= MAX_REMEMBERED) remembered.delete(remembered.keys().next().value);
  remembered.set(key, decision);
  return decision;
}

/** For tests. */
function forgetReviews() {
  remembered.clear();
}

module.exports = { CAPABILITY, reviewLoadAlarm, forgetReviews };
