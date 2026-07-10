/**
 * Trailer message parser — deterministic first pass.
 *
 * Reads a driver-group message (text OR photo caption) and, WITHOUT any AI,
 * classifies it and extracts the structured fields we can find with confidence.
 * The AI classifier (services/trailerClassifier.js) is only a fallback/enrichment
 * layer for messy input; this file handles the obvious, well-formed cases so the
 * common path never depends on a network call.
 *
 * Classification categories:
 *   - pickup     : a trailer unit + a clear "picked up" action
 *   - dropoff    : a trailer unit + a clear "dropped / dropped off" action
 *   - mention_only : a trailer keyword but no clear pickup/dropoff action
 *   - unidentified : looks trailer-related but too little to act on
 *
 * IMPORTANT: this parser never INVENTS a unit number, location, or condition.
 * When a field is not present in the text, it is left null and (for actions
 * with no unit) the message is treated as unidentified.
 */

// ── keyword vocabularies ──
// Presence of any of these means the message is at least "about trailers".
const TRAILER_KEYWORDS = [
  'trailer', 'trailers', 'trl', 'trailer #', 'trailer unit',
];
// "unit" alone is ambiguous (drivers also say "unit" for trucks), so it only
// counts as a trailer signal when paired with a trailer word or a unit token.
const PICKUP_PHRASES = [
  'picked up back', 'picked up', 'pick up', 'pickup', 'grabbed trailer',
  'grabbed the trailer', 'hooked trailer', 'hooked up', 'hooked to',
  'swapped trailer', 'swapped to', 'got the trailer', 'took the trailer',
  'took trailer', 'hooked the trailer', 'grabbed', 'hooked',
];
const DROPOFF_PHRASES = [
  'dropped off', 'drop off', 'dropped by', 'dropped', 'drop', 'left trailer',
  'left the trailer', 'trailer dropped', 'dropped the trailer', 'droped', // common typo
  'droped off', 'droping',
];

const CONDITION_KEYWORDS = [
  'no pictures', 'no photos', 'with pictures', 'with photos', 'damage',
  'damaged', 'flat tire', 'flat', 'lights issue', 'light issue', 'lights',
  'good condition', 'bad condition', 'empty', 'loaded', 'clean', 'dirty',
  'condition',
];

// ── cargo vocabularies ──
// Word-boundary regexes so "no load" does not match inside "unloaded", "mt" does
// not match inside "empty", etc. Order does not matter — detectCargoStatus runs
// both and resolves conflicts explicitly (both present → ambiguous → unknown).
const LOADED_PATTERNS = [
  /\bloaded\b/, /\bfull\b/, /\bwith\s+load\b/, /\bunder\s+load\b/, /\bsealed\b/,
  /\bwith\s+a\s+load\b/, /\bdrop(?:ped)?\s+loaded\b/,
];
const EMPTY_PATTERNS = [
  /\bempty\b/, /\bmt\b/, /\bno\s+load\b/, /\bunloaded\b/, /\bno\s+cargo\b/,
];

/** Lowercased, whitespace-collapsed copy for keyword scanning. */
function norm(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Normalize a unit number to a stable form: uppercase, no spaces/#. */
function normalizeUnitNumber(value) {
  if (value == null) return null;
  const t = String(value).toUpperCase().replace(/[#\s]+/g, '').trim();
  return t || null;
}

/** True when the message references trailers at all. */
function hasTrailerKeyword(text) {
  const t = norm(text);
  if (!t) return false;
  // \btrl\b matches "trl" / "trl#" but not "control".
  if (/\btr(ai)?l\b/.test(t)) return true;
  if (t.includes('trailer')) return true;
  return false;
}

/**
 * Pull a trailer unit number out of the text. Recognizes:
 *   "trl # ST508998", "trailer # VT700669", "trailer VM709984",
 *   "trl#ST508998", "unit ST508998" (only when a trailer word is also present).
 * A unit token is a run of letters/digits with at least one digit and length ≥3.
 * Returns the RAW matched token (not yet normalized) or null.
 */
function extractUnitNumber(text) {
  const raw = String(text || '');
  // Prefer a token that immediately follows a trailer/unit label.
  const labelled = raw.match(
    /\b(?:tr(?:ai)?l(?:er)?|unit)\s*(?:unit)?\s*#?\s*[:#]?\s*([A-Za-z]{0,4}\s?-?\d[\dA-Za-z-]{2,})/i
  );
  if (labelled && labelled[1]) {
    const candidate = normalizeUnitNumber(labelled[1]);
    if (candidate && /\d/.test(candidate) && candidate.length >= 3) return candidate;
  }
  // Fallback: a "# TOKEN" anywhere, when the message is trailer-related.
  if (hasTrailerKeyword(raw)) {
    const hashed = raw.match(/#\s*([A-Za-z]{0,4}-?\d[\dA-Za-z-]{2,})/);
    if (hashed && hashed[1]) {
      const candidate = normalizeUnitNumber(hashed[1]);
      if (candidate && /\d/.test(candidate) && candidate.length >= 3) return candidate;
    }
    // Fallback: a clear fleet-unit token (1–4 letters + 3+ digits, e.g. ST508998,
    // VT700669, AB100) anywhere in a trailer message even when it is not adjacent
    // to the trailer word ("swapped trailer to AB100", "trailer dropped ST201").
    const token = raw.match(/\b([A-Za-z]{1,4}-?\d{3,})\b/);
    if (token && token[1]) {
      const candidate = normalizeUnitNumber(token[1]);
      if (candidate && candidate.length >= 4) return candidate;
    }
  }
  return null;
}

/**
 * Extract a "Location: ..." value, or null. The separator is optional so
 * "Location: Lancaster PA" AND "location Lancaster PA" both work. Stops at the
 * end of the line and at any following field label on the same line
 * ("Location: Lancaster PA. Condition: no pictures" → "Lancaster PA") so a
 * one-line message never leaks the next field into the location text.
 */
function extractLocation(text) {
  const raw = String(text || '');
  const m = raw.match(/\blocation\s*[:\-]?\s*([^\n\r]+)/i);
  if (m && m[1]) {
    let val = m[1].trim();
    // Cut at a following labelled field ("Condition:", "Date -", "Driver:").
    val = val.split(/\s+(?:condition|date|driver|reefer|temp|status)\b\s*[:\-]/i)[0];
    val = val.replace(/[.,;]+\s*$/, '').trim();
    return val || null;
  }
  return null;
}

/** Extract a "Condition: ..." value; falls back to a known condition keyword. */
function extractCondition(text) {
  const raw = String(text || '');
  const m = raw.match(/\bcondition\s*[:\-]\s*([^\n\r]+)/i);
  if (m && m[1]) {
    const val = m[1].trim().replace(/[.,;]+$/, '').trim();
    if (val) return val;
  }
  const t = norm(raw);
  for (const kw of ['no pictures', 'no photos', 'with pictures', 'with photos',
    'flat tire', 'lights issue', 'good condition', 'bad condition', 'damage', 'damaged', 'empty']) {
    if (t.includes(kw)) return kw;
  }
  return null;
}

/** Extract a "Date: ..." value, or null. */
function extractDate(text) {
  const raw = String(text || '');
  const m = raw.match(/\bdate\s*[:\-]\s*([^\n\r]+)/i);
  if (m && m[1]) {
    const val = m[1].trim().replace(/[.,;]+$/, '').trim();
    return val || null;
  }
  return null;
}

/**
 * Extract a "Dropped by: NAME" / "Picked up by: NAME" reported-driver name.
 * Returns null when no explicit "... by: NAME" is present.
 */
function extractReportedDriverName(text) {
  const raw = String(text || '');
  const m = raw.match(/\b(?:dropped|droped|picked up|pick(?:ed)? up|grabbed|hooked)\s*(?:off|back)?\s*by\s*[:\-]?\s*([A-Za-z][A-Za-z .'\-]{1,60})/i);
  if (m && m[1]) {
    const val = m[1].trim().replace(/[.,;]+$/, '').trim();
    // Guard against capturing a following label like "Location".
    const cleaned = val.split(/\b(?:location|date|condition|trailer|trl)\b/i)[0].trim();
    return cleaned || null;
  }
  return null;
}

/** Which action does the text express? Returns 'pickup' | 'dropoff' | null. */
function detectAction(text) {
  const t = norm(text);
  if (!t) return null;

  // Score-based: a message could contain both words; pick the stronger/earlier.
  let pickupIdx = Infinity;
  let dropoffIdx = Infinity;
  for (const p of PICKUP_PHRASES) {
    const idx = t.indexOf(p);
    if (idx >= 0 && idx < pickupIdx) pickupIdx = idx;
  }
  for (const p of DROPOFF_PHRASES) {
    const idx = t.indexOf(p);
    if (idx >= 0 && idx < dropoffIdx) dropoffIdx = idx;
  }
  if (pickupIdx === Infinity && dropoffIdx === Infinity) return null;
  if (pickupIdx === Infinity) return 'dropoff';
  if (dropoffIdx === Infinity) return 'pickup';
  // Both present → the earlier phrase wins (mirrors how drivers phrase swaps).
  return pickupIdx <= dropoffIdx ? 'pickup' : 'dropoff';
}

/**
 * Explicit cargo signal in the text, independent of the pickup/dropoff action.
 * Returns 'loaded' | 'empty' | 'ambiguous' (both present) | null (neither).
 * NEVER infers from condition wording like "no pictures" — only the cargo
 * vocabularies above count.
 */
function detectCargoSignal(text) {
  const t = norm(text);
  if (!t) return null;
  const hasLoaded = LOADED_PATTERNS.some((re) => re.test(t));
  const hasEmpty = EMPTY_PATTERNS.some((re) => re.test(t));
  if (hasLoaded && hasEmpty) return 'ambiguous';
  if (hasLoaded) return 'loaded';
  if (hasEmpty) return 'empty';
  return null;
}

/**
 * Resolve possession + cargo from the action and the message text, applying the
 * core business rule: a DROPPED trailer defaults to EMPTY unless the message
 * clearly says loaded; a PICKED-UP trailer's cargo is UNKNOWN unless stated.
 * Returns { possessionStatus, cargoStatus, cargoAmbiguous }.
 */
function resolveCargoPossession(text, action) {
  const signal = detectCargoSignal(text);
  const cargoAmbiguous = signal === 'ambiguous';

  let possessionStatus = 'unknown';
  if (action === 'pickup') possessionStatus = 'with_driver';
  else if (action === 'dropoff') possessionStatus = 'dropped';

  let cargoStatus;
  if (signal === 'loaded') cargoStatus = 'loaded';
  else if (signal === 'empty') cargoStatus = 'empty';
  else if (signal === 'ambiguous') cargoStatus = 'unknown';
  else if (action === 'dropoff') cargoStatus = 'empty'; // dropped ⇒ empty by default
  else cargoStatus = 'unknown'; // pickup/none ⇒ unknown until stated

  return { possessionStatus, cargoStatus, cargoAmbiguous };
}

/**
 * Parse a message. Returns a structured result:
 *   {
 *     isTrailerRelated, eventType, trailerUnit, action,
 *     locationText, conditionText, eventDateText, reportedDriverName,
 *     confidence, reason, needsReview, method: 'deterministic'
 *   }
 *
 * Never throws.
 */
function parseTrailerMessage(text) {
  const raw = String(text || '');
  const trimmed = raw.trim();

  const base = {
    isTrailerRelated: false,
    eventType: 'unidentified',
    trailerUnit: null,
    action: null,
    possessionStatus: 'unknown',
    cargoStatus: 'unknown',
    locationText: null,
    conditionText: null,
    eventDateText: null,
    reportedDriverName: null,
    confidence: 0,
    reason: '',
    needsReview: false,
    method: 'deterministic',
  };

  if (!trimmed) {
    return { ...base, reason: 'empty message' };
  }

  const trailerRelated = hasTrailerKeyword(trimmed);
  const unit = extractUnitNumber(trimmed);
  const action = detectAction(trimmed);

  if (!trailerRelated && !unit) {
    // Not about trailers at all — caller should ignore (isTrailerRelated=false).
    return { ...base, reason: 'no trailer keyword or unit' };
  }

  const locationText = extractLocation(trimmed);
  const conditionText = extractCondition(trimmed);
  const eventDateText = extractDate(trimmed);
  const reportedDriverName = extractReportedDriverName(trimmed);

  const cargo = resolveCargoPossession(trimmed, action);

  base.isTrailerRelated = true;
  base.trailerUnit = unit;
  base.action = action;
  base.possessionStatus = cargo.possessionStatus;
  base.cargoStatus = cargo.cargoStatus;
  base.locationText = locationText;
  base.conditionText = conditionText;
  base.eventDateText = eventDateText;
  base.reportedDriverName = reportedDriverName;

  // ── classify ──
  if (unit && action) {
    // Strong signal: unit + clear action.
    let confidence = 70;
    if (locationText) confidence += 12;
    if (conditionText) confidence += 8;
    if (reportedDriverName) confidence += 5;
    confidence = Math.min(confidence, 98);
    return {
      ...base,
      eventType: action, // 'pickup' | 'dropoff'
      confidence,
      // no location on an action, OR conflicting loaded+empty wording → review.
      needsReview: !locationText || cargo.cargoAmbiguous,
      reason: cargo.cargoAmbiguous
        ? `unit ${unit} + ${action} (conflicting cargo wording — review)`
        : `unit ${unit} + ${action}`,
    };
  }

  if (!unit && action) {
    // Action but no unit — cannot register a responsibility record safely.
    return {
      ...base,
      eventType: 'unidentified',
      confidence: 25,
      needsReview: true,
      reason: `${action} action but no trailer unit`,
    };
  }

  if (unit && !action) {
    // Unit mentioned, no clear action.
    return {
      ...base,
      eventType: 'mention_only',
      confidence: 30,
      needsReview: true,
      reason: `unit ${unit} mentioned, no clear pickup/dropoff action`,
    };
  }

  // Trailer keyword only (e.g. "trailer?", "trl", "trailer issue").
  return {
    ...base,
    eventType: 'unidentified',
    confidence: 15,
    needsReview: true,
    reason: 'trailer keyword only, no unit or action',
  };
}

/**
 * Find every trailer-unit token that is prefixed by a trailer/unit LABEL or a
 * '#', with its start position. This anchors multi-event segmentation: one
 * driver message may name several trailers ("TRL# 403279 picked up / TRL# 171847
 * dropped"). Bare tokens with no label/# are deliberately NOT collected here —
 * splitting on those would be a guess. Returns [{ start, unit }] in order.
 */
function findUnitTokens(text) {
  const raw = String(text || '');
  const re = /(?:\b(?:tr(?:ai)?l(?:er)?|unit)\s*(?:unit)?\s*#?\s*[:#]?\s*|#\s*)([A-Za-z]{0,4}-?\d[\dA-Za-z-]{2,})/gi;
  const out = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    const unit = normalizeUnitNumber(m[1]);
    if (unit && /\d/.test(unit) && unit.length >= 3) {
      out.push({ start: m.index, unit });
    }
  }
  return out;
}

/** Build a parsed-event result for ONE known unit from its text segment. */
function parseSegmentForUnit(segment, unit, fallback = {}) {
  const action = detectAction(segment);
  const locationText = extractLocation(segment) || fallback.locationText || null;
  const conditionText = extractCondition(segment) || fallback.conditionText || null;
  const eventDateText = extractDate(segment) || fallback.eventDateText || null;
  const reportedDriverName = extractReportedDriverName(segment) || fallback.reportedDriverName || null;

  const cargo = resolveCargoPossession(segment, action);

  const base = {
    isTrailerRelated: true,
    eventType: 'mention_only',
    trailerUnit: unit,
    action,
    possessionStatus: cargo.possessionStatus,
    cargoStatus: cargo.cargoStatus,
    locationText,
    conditionText,
    eventDateText,
    reportedDriverName,
    confidence: 30,
    reason: `unit ${unit} mentioned, no clear pickup/dropoff action`,
    needsReview: true,
    method: 'deterministic',
  };

  if (action) {
    let confidence = 70;
    if (locationText) confidence += 12;
    if (conditionText) confidence += 8;
    if (reportedDriverName) confidence += 5;
    confidence = Math.min(confidence, 98);
    return {
      ...base,
      eventType: action,
      confidence,
      needsReview: !locationText || cargo.cargoAmbiguous,
      reason: cargo.cargoAmbiguous
        ? `unit ${unit} + ${action} (conflicting cargo wording — review)`
        : `unit ${unit} + ${action}`,
    };
  }
  return base;
}

/**
 * Parse a message into an ARRAY of events. When the message names two or more
 * labelled/# trailer units, each becomes its own event (segmented by unit
 * position, with a shared leading-preamble location/condition used only as a
 * fallback when a segment has none). Single-unit / non-trailer messages return a
 * one-element array holding exactly what parseTrailerMessage would return, so
 * existing single-event behavior is byte-for-byte preserved.
 *
 * Never throws. Never invents a unit. Ambiguous input collapses to the
 * single-event path (which yields mention_only/unidentified for review).
 */
function parseTrailerMessageEvents(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [parseTrailerMessage(text)];

  const tokens = findUnitTokens(trimmed);
  if (tokens.length < 2) return [parseTrailerMessage(text)];

  // Shared context that appears BEFORE the first unit (e.g. a leading
  // "Location: …" line) is used only to backfill segments that lack their own.
  const preambleText = trimmed.slice(0, tokens[0].start);
  const fallback = {
    locationText: extractLocation(preambleText),
    conditionText: extractCondition(preambleText),
    eventDateText: extractDate(preambleText),
    reportedDriverName: extractReportedDriverName(preambleText),
  };

  const results = [];
  for (let idx = 0; idx < tokens.length; idx += 1) {
    const start = tokens[idx].start;
    const end = idx + 1 < tokens.length ? tokens[idx + 1].start : trimmed.length;
    const segment = trimmed.slice(start, end);
    const parsed = parseSegmentForUnit(segment, tokens[idx].unit, fallback);
    parsed.eventIndex = idx;
    results.push(parsed);
  }
  return results;
}

/**
 * Should the AI classifier run as a fallback? Only when the deterministic pass
 * is uncertain: no unit, or an action-less trailer mention, or low confidence.
 */
function shouldUseAiFallback(parsed) {
  if (!parsed || !parsed.isTrailerRelated) return false;
  if (parsed.eventType === 'pickup' || parsed.eventType === 'dropoff') {
    return parsed.confidence < 75; // solid action → trust deterministic
  }
  return true; // mention_only / unidentified → let AI try to enrich
}

module.exports = {
  parseTrailerMessage,
  parseTrailerMessageEvents,
  findUnitTokens,
  hasTrailerKeyword,
  extractUnitNumber,
  extractLocation,
  extractCondition,
  extractDate,
  extractReportedDriverName,
  detectAction,
  detectCargoSignal,
  resolveCargoPossession,
  normalizeUnitNumber,
  shouldUseAiFallback,
  TRAILER_KEYWORDS,
  PICKUP_PHRASES,
  DROPOFF_PHRASES,
  CONDITION_KEYWORDS,
};
