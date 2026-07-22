/**
 * Home-time wording detectors (pure, no I/O) — the single source of truth for
 * "does this text talk about going home / taking time off?" and, just as
 * importantly, "is this only a brief stop / errand near home?".
 *
 * Strengths, so callers can trade recall for precision:
 *
 *   - hasHomeTimeSignal:        BROAD. Any home-time / time-off phrasing, including
 *     softer "going/heading home". Used as a cheap candidate hint and as the guard
 *     for a low-confidence AI "yes" on the approver-tag path (a human already
 *     escalated by tagging a manager, so broad recall is appropriate there).
 *   - hasStrongHomeTimeSignal:  STRICT subset. Only unambiguous time-off wording
 *     ("home time", "days off", "PTO", "vacation", "send them home", "wants to go
 *     home", "home for N days"). Used where a false positive is costly and there
 *     is no human in the loop: the AI-unavailable fallback and the driver-initiated
 *     precision guard. This is what keeps an ordinary message that merely mentions
 *     "home" ("almost home", "heading home for the night", "Home Depot") from
 *     opening a home-time request on its own.
 *   - hasExplicitTimeOffSignal: STRICTEST subset. Only wording that CANNOT be
 *     explained away as a quick errand ("home time", "days off", "PTO", "vacation",
 *     "home for N days", "send them home"). Notably EXCLUDES the bare "wants/needs
 *     to go home" verb, which is genuinely ambiguous with "go home to grab X".
 *   - hasHomeErrandSignal:      the negative signal. Brief-stop / errand markers
 *     ("pass by the house", "pick up his belongings", "drop off", "hometown",
 *     "for the night", "oil change/appointment near home"). This is what lets the
 *     workflow tell a temporary stop apart from real time off.
 *
 * STRONG is defined as EXPLICIT ∪ GO_HOME and BROAD as STRONG ∪ WEAK, so the sets
 * never drift apart and there is no duplicated pattern list to keep in sync.
 */

// Unambiguous "taking time off" wording. Cannot be explained away as a quick
// errand, so a match here is genuine home-time intent even without the AI.
const HOME_TIME_EXPLICIT_TIMEOFF_PATTERNS = [
  /\bhome[\s-]*time\b/i,
  /\bhometime\b/i,
  /\btime\s*off\b/i,
  /\bdays?\s*off\b/i,
  /\boff\s*days?\b/i,
  /\bsend\s+(?:me|him|her|them|the\s+driver)\s+home\b/i,
  // "home for a week / a few days / 4 days" — requires an explicit time-off
  // duration so incidental "home for the night/weekend" never counts.
  /\bhome\s+for\s+(?:\d+|an?|a\s+few|a\s+couple|some|several)\s+(?:days?|weeks?)\b/i,
  /\bvacation\b/i,
  /\bpto\b/i,
];

// "wants / needs to go home" — a request to be home, but the verb "go home" is
// ambiguous with a brief errand ("go home to grab X"), so it is deliberately NOT
// part of the EXPLICIT set. It stays STRONG so the existing broad/strong contract
// is unchanged; the errand detector below is what disambiguates it.
const HOME_TIME_GO_HOME_PATTERNS = [
  /\b(?:needs?|wants?|asking|like)\s+(?:to\s+)?(?:go|get|come|head)\s+home\b/i,
];

// Unambiguous "asking for time off" wording. STRONG = EXPLICIT ∪ GO_HOME, which
// preserves the exact original strong-signal set (`.some()` is order-independent,
// so the boolean result of hasStrongHomeTimeSignal is unchanged).
const HOME_TIME_STRONG_SIGNAL_PATTERNS = [
  ...HOME_TIME_EXPLICIT_TIMEOFF_PATTERNS,
  ...HOME_TIME_GO_HOME_PATTERNS,
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

// Brief-stop / errand markers: the driver is passing by, grabbing or dropping
// something, sleeping home a single night, or stopping for a personal operational
// reason — NOT taking time off. These are the "pass by the house to grab
// belongings" family the workflow must never treat as a home-time request.
const HOME_ERRAND_SIGNAL_PATTERNS = [
  // A brief detour: pass / swing / stop / drop / run / come / go / head + by|past.
  /\b(?:pass|swing|stop|drop|run|come|go|going|goes|head|heading|driv\w*)\w*\s+(?:by|past)\b/i,
  // Passing through the area / the driver's hometown.
  /\bpass(?:ing|es|ed)?\s+through\b/i,
  /\bhome\s*town\b/i,
  // Dropping something / someone off (at home).
  /\bdrop(?:ping|ped|s)?\s+(?:\w+\s+){0,2}off\b/i,
  // Picking up / grabbing / collecting / getting a specific personal item. The
  // object anchor keeps this from firing on "get home" / "take a break".
  /\b(?:pick(?:ing|ed|s)?\s*up|grab(?:bing|bed|s)?|collect(?:ing|ed|s)?|retriev\w+|fetch(?:ing|ed|es)?|get(?:ting|s)?|tak(?:e|ing|es)|drop(?:ping|ped|s)?|leav\w+)\b[^.!?\n]{0,30}\b(?:belonging|clothe|clothing|stuff|thing|item|document|paperwork|medicine|meds|medication|equipment|tool|part|mail|package|wallet|phone|laptop|charger|bag|gear|glasses|key|luggage|suitcase)s?\b/i,
  // "personal belongings / personal items / personal stuff / personal effects".
  /\bpersonal\s+(?:belonging|item|thing|stuff|effect)/i,
  // Sleeping at home a single night because the route passes nearby.
  /\bfor\s+the\s+night\b/i,
  /\b(?:one|1)\s+night\b/i,
  /\bover\s*night\b/i,
  // Personal operational stops near home (an appointment, not time off).
  /\b(?:oil\s*change|appointment|dentist|doctor(?:'s)?|the\s+mechanic)\b/i,
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

/**
 * True only for time-off wording that a quick errand cannot explain ("home time",
 * "days off", "PTO", "vacation", "home for N days", "send them home"). Used to
 * decide whether an errand-flavoured message still carries genuine home-time
 * intent. Deliberately excludes the bare "wants/needs to go home" verb.
 */
function hasExplicitTimeOffSignal(text) {
  const str = String(text || '');
  return HOME_TIME_EXPLICIT_TIMEOFF_PATTERNS.some((re) => re.test(str));
}

/** True when the text carries a brief-stop / errand marker (the negative signal). */
function hasHomeErrandSignal(text) {
  const str = String(text || '');
  return HOME_ERRAND_SIGNAL_PATTERNS.some((re) => re.test(str));
}

/**
 * Decision helper: does this wording describe a brief stop / errand near home
 * rather than taking time off? True ONLY when an errand marker is present AND
 * there is no genuine time-off evidence — neither explicit time-off wording nor a
 * concrete date/window (`hasDate`). This is the deterministic backstop for the
 * "pass by the house to grab belongings" case: it lets the workflow refuse to
 * open a request even when the AI is confident or unavailable, because the meaning
 * of the text does not support real home time.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.hasDate=false] a concrete home-time date/window is known
 */
function looksLikeTemporaryHomeStop(text, { hasDate = false } = {}) {
  const str = String(text || '');
  if (hasDate) return false;
  if (hasExplicitTimeOffSignal(str)) return false;
  return hasHomeErrandSignal(str);
}

module.exports = {
  HOME_TIME_SIGNAL_PATTERNS,
  HOME_TIME_STRONG_SIGNAL_PATTERNS,
  HOME_TIME_EXPLICIT_TIMEOFF_PATTERNS,
  HOME_TIME_GO_HOME_PATTERNS,
  HOME_TIME_WEAK_SIGNAL_PATTERNS,
  HOME_ERRAND_SIGNAL_PATTERNS,
  hasHomeTimeSignal,
  hasStrongHomeTimeSignal,
  hasExplicitTimeOffSignal,
  hasHomeErrandSignal,
  looksLikeTemporaryHomeStop,
};
