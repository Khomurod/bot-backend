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

// ── multilingual action hints (Uzbek Latin/Cyrillic, Russian) ──
// Used ONLY by the cheap candidate filter to decide that a message MIGHT be a
// trailer action worth sending to semantic AI verification. These hints never
// authorize a state change by themselves — completed-vs-planned is the semantic
// verifier's job. Word-boundary-ish regexes tolerant of suffixes.
const MULTILINGUAL_PICKUP_HINTS = [
  // Uzbek Latin: oldim (I took), olib oldim, olaman (I will take), olasiz (you
  // will take), olamiz, oladi, olib boraman/borasiz, ildim (hooked)
  /\bol(?:dim|dik|di|aman|asiz|amiz|adi|ib)\b/i, /\bolib\s+ol/i, /\bil(?:dim|di)\b/i,
  // Uzbek Cyrillic + Russian. NOTE: \b is ASCII-only in JS, so Cyrillic words
  // use explicit letter lookarounds instead.
  /(?<![а-яё])(?:олдим|оламан|оласиз|олади|олиб)(?![а-яё])/i,
  // Russian: забрал(а), заберу, забери, забрать, взял, возьму, возьмёшь,
  // подцепил, прицепил, зацепил
  /(?<![а-яё])забрал[аи]?(?![а-яё])/i, /(?<![а-яё])забер[уиёе][а-яё]*(?![а-яё])/i,
  /(?<![а-яё])забрать(?![а-яё])/i, /(?<![а-яё])вз[яе]л[аи]?(?![а-яё])/i,
  /(?<![а-яё])возьм[уёе][а-яё]*(?![а-яё])/i, /(?<![а-яё])(?:под|при|за)цепил[аи]?(?![а-яё])/i,
];
const MULTILINGUAL_DROPOFF_HINTS = [
  // Uzbek Latin: tashladim (I dropped), tashlayman, tashlaysiz, tashlab,
  // qoldirdim (I left), qoldiraman, qo'ydim (I put/left)
  /\btashla(?:dim|dik|di|yman|ysiz|b)\b/i, /\bqoldir(?:dim|dik|di|aman|asiz)\b/i, /\bqo['’`ʻ]?ydim\b/i,
  // Uzbek Cyrillic
  /(?<![а-яё])(?:ташладим|ташлайман|қолдирдим|колдирдим)(?![а-яёқ])/i,
  // Russian: сбросил, скинул, бросил, оставил, оставлю, отцепил, брошу
  /(?<![а-яё])с?брос[иы]л[аи]?(?![а-яё])/i, /(?<![а-яё])скинул[аи]?(?![а-яё])/i,
  /(?<![а-яё])остав(?:ил[аи]?|лю|ь)(?![а-яё])/i, /(?<![а-яё])отцепил[аи]?(?![а-яё])/i,
  /(?<![а-яё])брошу(?![а-яё])/i, /(?<![а-яё])скину(?![а-яё])/i,
];

/**
 * Multilingual (uz/ru) action hint: does the text look like it MIGHT describe a
 * trailer pickup/drop-off action in Uzbek or Russian? Returns 'pickup' |
 * 'dropoff' | null. Detection only — tense/intent is NOT decided here.
 */
function detectMultilingualActionHint(text) {
  const raw = String(text || '');
  if (!raw) return null;
  if (MULTILINGUAL_PICKUP_HINTS.some((re) => re.test(raw))) return 'pickup';
  if (MULTILINGUAL_DROPOFF_HINTS.some((re) => re.test(raw))) return 'dropoff';
  return null;
}

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
// NOTE: a standalone "full" is NOT cargo evidence — drivers write "no full
// pictures", "full set of photos", "full inspection". Only cargo-specific
// phrasings ("full trailer", "trailer is full") count as loaded.
const LOADED_PATTERNS = [
  /\bloaded\b/, /\bwith\s+load\b/, /\bunder\s+load\b/, /\bsealed\b/,
  /\bwith\s+a\s+load\b/, /\bdrop(?:ped)?\s+loaded\b/,
  /\bfull\s+trailer\b/, /\btrailer\s+(?:is\s+)?full\b/,
];
const EMPTY_PATTERNS = [
  /\bempty\b/, /\bmt\b/, /\bno\s+load\b/, /\bunloaded\b/, /\bno\s+cargo\b/,
];

const {
  isValidTrailerUnitFormat,
  isNonTrailerContextNumber,
} = require('./trailerUnitValidation');

/** Lowercased, whitespace-collapsed copy for keyword scanning. */
function norm(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Re-exported below so existing `require('./trailerMessageParser')` callers keep
// working. The implementation lives in trailerMasterList/normalize, the single
// owner shared with the database layer — an independent copy here would let
// parser matching drift away from master-list matching.
const { normalizeUnitNumber } = require('./trailerMasterList/normalize');

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
  // Central acceptance rule: strict format (digit, 4–20 chars, charset, not a
  // reserved word like "TRL") + not a facility/load/door-style "#number".
  const accept = (value) => {
    const candidate = normalizeUnitNumber(value);
    if (!candidate) return null;
    if (!isValidTrailerUnitFormat(candidate).valid) return null;
    if (isNonTrailerContextNumber(candidate, raw)) return null;
    return candidate;
  };
  // Prefer a token that immediately follows a trailer/unit label.
  const labelled = raw.match(
    /\b(?:tr(?:ai)?l(?:er)?|unit)\s*(?:unit)?\s*#?\s*[:#]?\s*([A-Za-z]{0,4}\s?-?\d[\dA-Za-z-]{2,})/i
  );
  if (labelled && labelled[1]) {
    const candidate = accept(labelled[1]);
    if (candidate) return candidate;
  }
  if (hasTrailerKeyword(raw)) {
    // Fallback: a "# TOKEN" — but only when it is NOT attached to a facility /
    // load / door / PO-style label ("Home Depot MDO/DFC #5829", "Load #9492869").
    const hashedRe = /#\s*([A-Za-z]{0,4}-?\d[\dA-Za-z-]{2,})/g;
    let hm;
    while ((hm = hashedRe.exec(raw)) !== null) {
      const candidate = accept(hm[1]);
      if (candidate) return candidate;
    }
    // Fallback: a clear fleet-unit token (1–4 letters + 3+ digits, e.g. ST508998,
    // VT700669, AB100) anywhere in a trailer message even when it is not adjacent
    // to the trailer word ("swapped trailer to AB100", "trailer dropped ST201").
    const token = raw.match(/\b([A-Za-z]{1,4}-?\d{3,})\b/);
    if (token && token[1]) {
      const candidate = accept(token[1]);
      if (candidate) return candidate;
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

// ── instruction / assignment phrasing (NOT a completed action) ──
// A message that ASSIGNS a pickup/drop-off location or COMMANDS one ("Trailer
// drop-off address: …", "drop this trailer at …", "pickup address: …") must
// never register a completed event. English patterns only here — the semantic
// AI handles the long multilingual tail; this deterministic guard just keeps the
// obvious label/imperative cases out of the completed-action path (and out of
// the legacy no-AI path). NOTE: order-independent, checked only when NO
// completion signal is present.
const DROPOFF_INSTRUCTION_PATTERNS = [
  /\bdrop[\s-]?off\s+address\b/i,
  /\bdrop[\s-]?off\s+location\b/i,
  /\bdrop[\s-]?off\s+point\b/i,
  /\baddress\s+(?:for|to)\s+(?:the\s+)?drop/i,
  /\bdrop\s+(?:this|the|it|your)?\s*trailer\s+(?:at|to|here|off\s+at)\b/i,
  /\b(?:take|bring|leave)\s+(?:this|the|your)?\s*trailer\s+(?:to|at|here)\b/i,
  /\bwhere\s+(?:to|you\s+(?:need\s+to\s+)?)\s*drop\b/i,
];
const PICKUP_INSTRUCTION_PATTERNS = [
  /\bpick[\s-]?up\s+address\b/i,
  /\bpick[\s-]?up\s+location\b/i,
  /\bpick[\s-]?up\s+point\b/i,
  /\baddress\s+(?:for|to)\s+(?:the\s+)?pick/i,
  /\bpick\s+(?:it|this|the)?\s*up\s+(?:from|at)\b/i,
];
// Clear English completion evidence — its presence means the message is NOT a
// mere instruction (a real "dropped/picked up/left it" report).
const COMPLETION_SIGNAL_RE =
  /\b(?:dropped|droped|picked\s+up|left\s+(?:it|the\s+trailer|trailer\s+there|them)|hooked\s+up|hooked\s+to|grabbed\s+(?:the\s+)?trailer|drop\s+completed|already\s+(?:dropped|delivered|picked))\b/i;

/** True when the text contains clear English completed-action wording. */
function hasCompletionSignal(text) {
  return COMPLETION_SIGNAL_RE.test(String(text || ''));
}

/**
 * Instruction/assignment hint: does the text ASSIGN or COMMAND a pickup/drop-off
 * (an address/location/imperative) rather than report a completed action?
 * Returns 'pickup' | 'dropoff' | null. Returns null when a completion signal is
 * present (a real report wins over an instruction reading).
 */
function detectInstructionPhrase(text) {
  const raw = String(text || '');
  if (!raw || hasCompletionSignal(raw)) return null;
  if (DROPOFF_INSTRUCTION_PATTERNS.some((re) => re.test(raw))) return 'dropoff';
  if (PICKUP_INSTRUCTION_PATTERNS.some((re) => re.test(raw))) return 'pickup';
  return null;
}

/**
 * Best-effort extraction of a US-style street address line (number + street +
 * state/zip) for a planned-instruction destination. Returns the trimmed line or
 * null. Used only when there is no explicit "Location:" label.
 */
function extractAddressLine(text) {
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const looksLikeStreet = /\d{1,6}\s+[A-Za-z0-9.'’-]+(?:\s+[A-Za-z0-9.'’-]+){1,}/.test(line);
    const hasStateOrZip = /(?:,\s*[A-Z]{2}\b)|\b\d{5}(?:-\d{4})?\b/.test(line);
    if (looksLikeStreet && hasStateOrZip) {
      return line.replace(/[.,;]+\s*$/, '').trim();
    }
  }
  return null;
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
    isInstruction: false,
    instructionAction: null,
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
  const instruction = detectInstructionPhrase(trimmed);

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
  // Instruction/assignment ("Trailer drop-off address: …", "drop this trailer
  // at …") — an assignment or command, NOT a completed action. It must never
  // register a completed event or change status; it is captured as a PLANNED
  // instruction. We keep `action` set so the message still reaches semantic AI
  // verification, but eventType is mention_only so the legacy no-AI register
  // path can never fire on it.
  if (unit && instruction) {
    return {
      ...base,
      eventType: 'mention_only',
      action: instruction,
      isInstruction: true,
      instructionAction: instruction,
      possessionStatus: 'unknown',
      cargoStatus: 'unknown',
      locationText: locationText || extractAddressLine(trimmed),
      confidence: 45,
      needsReview: false,
      reason: `${instruction} instruction/assignment (location given; not a completed action)`,
    };
  }

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
    if (!unit) continue;
    // Same strict rule as extractUnitNumber: valid format AND not a facility /
    // load / door-style number ("Home Depot MDO/DFC #5829" is not a trailer).
    if (!isValidTrailerUnitFormat(unit).valid) continue;
    if (isNonTrailerContextNumber(unit, raw)) continue;
    out.push({ start: m.index, unit });
  }
  return out;
}

/** Build a parsed-event result for ONE known unit from its text segment. */
function parseSegmentForUnit(segment, unit, fallback = {}) {
  const action = detectAction(segment);
  const instruction = detectInstructionPhrase(segment);
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
    isInstruction: false,
    instructionAction: null,
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

  // Instruction/assignment — never a completed action (see parseTrailerMessage).
  if (instruction) {
    return {
      ...base,
      action: instruction,
      isInstruction: true,
      instructionAction: instruction,
      possessionStatus: 'unknown',
      cargoStatus: 'unknown',
      locationText: locationText || extractAddressLine(segment),
      confidence: 45,
      needsReview: false,
      reason: `${instruction} instruction/assignment (location given; not a completed action)`,
    };
  }

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
  detectMultilingualActionHint,
  detectInstructionPhrase,
  hasCompletionSignal,
  extractAddressLine,
  detectCargoSignal,
  resolveCargoPossession,
  normalizeUnitNumber,
  shouldUseAiFallback,
  TRAILER_KEYWORDS,
  PICKUP_PHRASES,
  DROPOFF_PHRASES,
  CONDITION_KEYWORDS,
};
