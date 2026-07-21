/**
 * Home-time wording detectors (pure, no I/O) — the single source of truth for
 * "does this text talk about going home / taking time off?".
 *
 * Two strengths, so callers can trade recall for precision:
 *
 *   - hasHomeTimeSignal:       BROAD. Any home-time / time-off phrasing, including
 *     softer "going/heading home". Used as a cheap candidate hint and as the guard
 *     for a low-confidence AI "yes" on the approver-tag path (a human already
 *     escalated by tagging a manager, so broad recall is appropriate there).
 *   - hasStrongHomeTimeSignal: STRICT subset. Only unambiguous time-off wording
 *     ("home time", "days off", "PTO", "vacation", "send them home", "wants to go
 *     home", "home for N days"). Used where a false positive is costly and there
 *     is no human in the loop: the AI-unavailable fallback and the driver-initiated
 *     precision guard. This is what keeps an ordinary message that merely mentions
 *     "home" ("almost home", "heading home for the night", "Home Depot") from
 *     opening a home-time request on its own.
 *
 * BROAD is defined as STRONG ∪ WEAK so the two never drift apart and there is no
 * duplicated pattern list to keep in sync.
 */

// Unambiguous "asking for time off" wording. A match here alone is enough to
// treat a message as a home-time request even without the AI.
const HOME_TIME_STRONG_SIGNAL_PATTERNS = [
  /\bhome[\s-]*time\b/i,
  /\bhometime\b/i,
  /\btime\s*off\b/i,
  /\bdays?\s*off\b/i,
  /\boff\s*days?\b/i,
  /\bsend\s+(?:me|him|her|them|the\s+driver)\s+home\b/i,
  /\b(?:needs?|wants?|asking|like)\s+(?:to\s+)?(?:go|get|come|head)\s+home\b/i,
  // "home for a week / a few days / 4 days" — requires an explicit time-off
  // duration so incidental "home for the night/weekend" never counts as strong.
  /\bhome\s+for\s+(?:\d+|an?|a\s+few|a\s+couple|some|several)\s+(?:days?|weeks?)\b/i,
  /\bvacation\b/i,
  /\bpto\b/i,
];

// Softer, ambiguous phrasing — "home" as a place or a direction of travel. This
// needs the AI (or an explicit approver tag) to confirm real intent; on its own,
// during an AI outage, it is NOT enough to open a request.
const HOME_TIME_WEAK_SIGNAL_PATTERNS = [
  /\bgo(?:ing|es)?\s+home\b/i,
  /\bhead(?:ing|ed|s)?\s+home\b/i,
  /\bget(?:ting|s)?\s+home\b/i,
  /\bcome(?:s|ing)?\s+home\b/i,
  /\bat\s+the\s+house\b/i,
  /\bday(?:s)?\s+(?:at\s+)?home\b/i,
];

// BROAD = strong ∪ weak. Preserves the exact original hasHomeTimeSignal set;
// `.some()` is order-independent so the boolean result is unchanged.
const HOME_TIME_SIGNAL_PATTERNS = [
  ...HOME_TIME_STRONG_SIGNAL_PATTERNS,
  ...HOME_TIME_WEAK_SIGNAL_PATTERNS,
];

/** True when free text contains any home-time / time-off wording (broad recall). */
function hasHomeTimeSignal(text) {
  const str = String(text || '');
  return HOME_TIME_SIGNAL_PATTERNS.some((re) => re.test(str));
}

/** True only for unambiguous time-off wording (strict precision). */
function hasStrongHomeTimeSignal(text) {
  const str = String(text || '');
  return HOME_TIME_STRONG_SIGNAL_PATTERNS.some((re) => re.test(str));
}

module.exports = {
  HOME_TIME_SIGNAL_PATTERNS,
  HOME_TIME_STRONG_SIGNAL_PATTERNS,
  HOME_TIME_WEAK_SIGNAL_PATTERNS,
  hasHomeTimeSignal,
  hasStrongHomeTimeSignal,
};
