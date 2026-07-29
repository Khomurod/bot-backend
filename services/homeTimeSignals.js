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

// Ordinary OPERATIONAL conversation. A driver group is mostly load, repair and
// appointment talk, and a lot of it happens to contain "home", "road" or
// "yo'lda" — "700 ml yurmaydi bu trailer. Yo'lda fix qilsak bo'ladimi aka" is a
// trailer repair question, not a home-time request or a road-status change.
//
// These are the NEGATIVE operational signals. Like the errand markers they only
// bite when there is no explicit time-off wording, so a genuine request that
// merely mentions a load or a yard is unaffected.
//
// Uzbek/Russian forms are included because the driver groups actually use them.
// Cyrillic entries omit \b — JS word boundaries are ASCII-only and would never
// fire before a Cyrillic letter.
const OPERATIONAL_CONTEXT_PATTERNS = [
  // Repairs, breakdowns, maintenance.
  /\brepair(?:s|ed|ing)?\b/i,
  /\bbreak\s*down\b/i, /\bbroke(?:n)?\s+down\b/i,
  /\btires?\b/i, /\btyres?\b/i, /\bflat\b/i,
  /\bmechanic\b/i, /\bshop\b/i, /\bmaintenance\b/i, /\bservice\s+truck\b/i,
  /\bfix(?:ed|ing)?\b/i, /\bfix\s*qil/i, /\bremont/i, /\bshina\b/i,
  /\btrailer\b/i, /\breefer\b/i, /\bengine\b/i, /\bbrakes?\b/i,
  /ремонт/i, /поломк/i,
  // Load / rate / paperwork.
  /\bload(?:s|ed|ing)?\b/i, /\brate\s*con(?:firmation)?\b/i, /\brate\b/i,
  /\bbol\b/i, /\bpod\b/i, /\bpaperwork\b/i, /\binvoice\b/i, /\bdetention\b/i,
  /\bgruz/i, /груз/i, /\bstavka/i, /ставк/i,
  // Pickup / delivery / facilities.
  /\bpick\s*up\s+(?:is|at|in|on|time|number|#)\b/i, /\bpu\s*#/i,
  /\bdeliver(?:y|ies|ed|ing)?\b/i, /\bdrop\s*off\s+(?:is|at|in|on)\b/i,
  /\bshipper\b/i, /\breceiver\b/i, /\bconsignee\b/i, /\bwarehouse\b/i,
  // Yard / terminal / parking.
  /\byard\b/i, /\bterminal\b/i, /\bparking\b/i, /\btruck\s*stop\b/i,
  /\bto\s+the\s+truck\b/i, /\bat\s+the\s+truck\b/i,
  // ETA / appointment / departure timing.
  /\beta\b/i, /\bappt\b/i, /\bappointment\b/i,
  /\bdeparture\b/i, /\bdepart(?:s|ing|ed)?\b/i,
  /\bdispatch(?:er|ed|ing)?\b/i,
];

// First-person, present-tense status wording. An AI-detected (non-deterministic)
// status change is only trusted from the driver speaking about themselves right
// now — "I'm home", "men uydaman", "я дома" — never a third party reporting on
// them ("he is currently at home and will let us know once he gets to the
// truck", which is an ETA update, not a state change).
const FIRST_PERSON_STATUS_PATTERNS = [
  /\bi\s*(?:'|’)?\s*m\b/i, /\bi\s+am\b/i, /\bim\b/i,
  /\bi\s+(?:just\s+)?(?:got|arrived|reached|made\s+it)\b/i,
  /\bi\s+(?:will|'ll|am\s+going\s+to)\b/i,
  /\bmy\s+(?:home|truck|status)\b/i,
  /\bwe\s*(?:'|’)?\s*re\b/i, /\bwe\s+are\b/i,
  // Uzbek 1st-person: uydaman, yo'ldaman, keldim, ketdim, boraman.
  /\b\w*(?:da|ga)man\b/i, /\b\w+dim\b/i, /\b\w+aman\b/i,
  // Russian 1st-person: я дома, я в пути, приехал, выехал (no explicit pronoun).
  // "я" needs an explicit non-Cyrillic boundary — a JS \b is ASCII-only and would
  // never fire before/after a Cyrillic letter (same trap as the hint lists above).
  /(?:^|[^а-яё])я(?:\s|$)/i, /приехал/i, /выехал/i, /доехал/i,
];

// Third-person reporting ABOUT the driver. Present so a staff update is never
// mistaken for the driver's own statement even if some first-person-looking
// fragment appears elsewhere in the same message.
const THIRD_PERSON_STATUS_PATTERNS = [
  /\b(?:he|she|they|driver|the\s+driver)\s+(?:is|are|was|were|has|have|will|'s)\b/i,
  /\bhe\s*(?:'|’)?s\b/i,
  /\blet\s+us\s+know\b/i, /\blet\s+me\s+know\b/i,
  /\bwill\s+(?:let|update|inform|advise)\b/i,
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

/** True when the text carries ordinary operational-conversation wording. */
function hasOperationalContextSignal(text) {
  const str = String(text || '');
  return OPERATIONAL_CONTEXT_PATTERNS.some((re) => re.test(str));
}

/**
 * Decision helper mirroring looksLikeTemporaryHomeStop: is this just ordinary
 * operational conversation that happens to mention home/road?
 *
 * True ONLY when an operational marker is present AND there is no genuine
 * time-off evidence — neither explicit time-off wording nor a concrete
 * date/window. That asymmetry is what lets "700 ml yurmaydi bu trailer. Yo'lda
 * fix qilsak bo'ladimi aka" be refused while "I need four days of home time,
 * my trailer is at the yard" still opens a request.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.hasDate=false] a concrete home-time date/window is known
 */
function looksLikeOperationalContext(text, { hasDate = false } = {}) {
  const str = String(text || '');
  if (hasDate) return false;
  if (hasExplicitTimeOffSignal(str)) return false;
  return hasOperationalContextSignal(str);
}

/**
 * True when the text reads as the DRIVER describing their own current status
 * ("I'm home", "men uydaman"), rather than someone reporting about them.
 * Third-person reporting wins outright: a message that talks about "he/she/the
 * driver" is never treated as a first-person statement.
 */
function looksLikeFirstPersonStatus(text) {
  const str = String(text || '');
  if (THIRD_PERSON_STATUS_PATTERNS.some((re) => re.test(str))) return false;
  return FIRST_PERSON_STATUS_PATTERNS.some((re) => re.test(str));
}

module.exports = {
  HOME_TIME_SIGNAL_PATTERNS,
  OPERATIONAL_CONTEXT_PATTERNS,
  FIRST_PERSON_STATUS_PATTERNS,
  THIRD_PERSON_STATUS_PATTERNS,
  hasOperationalContextSignal,
  looksLikeOperationalContext,
  looksLikeFirstPersonStatus,
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
