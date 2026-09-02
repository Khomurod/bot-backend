/**
 * At-risk and star SCORING — PURE functions.
 *
 * The two rules that decide whether a driver is surfaced to a manager, kept
 * separate from the aggregation that feeds them and the detectors that consume
 * them so each can be asserted on its own.
 *
 * Split out of services/aiInsightsService.js, which re-exports these.
 */
const { AT_RISK_SCORE_THRESHOLD, STAR_SCORE_THRESHOLD } = require('./constants');

// ── Detection rules ────────────────────────────────────────────────
function scoreAtRisk(b) {
  const s = b.stats;
  const intents = s.intents;
  return (
    (intents.quit_signal || 0) * 5 +
    (intents.complaint || 0) * 1.5 +
    (intents.home_time_request || 0) * 0.7 +
    (intents.conflict || 0) * 2 +
    s.neg_count * 1 +
    s.toxic_count * 2 +
    (s.sentiment_min <= -2 ? 2 : 0)
  );
}

function scoreStar(b) {
  const s = b.stats;
  const intents = s.intents;
  return (
    (intents.praise || 0) * 2 +
    s.pos_count * 0.8 +
    (intents.acknowledgement || 0) * 0.15 +
    (s.neg_count === 0 && s.pos_count >= 2 ? 1 : 0) -
    s.neg_count * 0.5 -
    s.toxic_count * 3
  );
}

module.exports = {
  scoreAtRisk,
  scoreStar,
};
