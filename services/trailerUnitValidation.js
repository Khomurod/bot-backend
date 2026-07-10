/**
 * Strict trailer-unit validation — the single gatekeeper for what may be stored
 * as a trailer unit number. Every path that can write a trailer unit into the
 * responsibility ledger (deterministic parse, AI classification, semantic
 * verification, vision extraction) must pass this module first.
 *
 * A valid trailer unit:
 *   1. contains at least one digit,
 *   2. is 4–20 characters after normalization,
 *   3. contains only letters, numbers, and hyphens,
 *   4. is not a reserved trailer-vocabulary word ("TRL", "TRAILER", …),
 *   5. (for full validation) appears EXACTLY in a grounded source — the current
 *      text/caption, the replied-to text/caption, or a verified image/vision
 *      extraction. AI output alone is never a grounded source.
 *
 * This module never throws.
 */

/** Words that look like unit tokens but are trailer vocabulary — never units. */
const RESERVED_UNIT_WORDS = new Set([
  'TRL', 'TRAILER', 'TRAIL', 'TRAILERS', 'UNIT', 'UNITS',
  'PICKUP', 'PICKED', 'DROPPED', 'DROP', 'DROPOFF', 'DROPS',
  'LOADED', 'LOAD', 'EMPTY', 'UNKNOWN', 'NULL', 'NONE', 'N-A',
]);

/**
 * Labels whose "#123" numbers are NOT trailers: facility/store, load, door,
 * PO, exit, dock, gate, order, seal, route, stop, bay, ref, lot numbers.
 * Matched against the text immediately BEFORE a bare "#number" token.
 */
const NON_TRAILER_NUMBER_LABEL_RE =
  /\b(?:load|door|po|p\.o\.|store|exit|dock|gate|order|seal|route|stop|bay|ref|reference|lot|mdo|dfc|dc|invoice|bol|pro|case|ticket|room|suite|apt|hwy|highway|building|bldg)\s*$/i;

/** Trailer labels that legitimize a bare "#number" as a trailer unit. */
const TRAILER_LABEL_RE = /\b(?:tr(?:ai)?l(?:er)?s?|trailer\s+unit|unit)\s*(?:unit)?\s*$/i;

/** Normalize a candidate to the stable stored form: upper, no spaces/#. */
function normalizeUnitCandidate(value) {
  if (value == null) return null;
  const t = String(value).toUpperCase().replace(/[#\s]+/g, '').trim();
  return t || null;
}

/** Is the value a reserved trailer-vocabulary word (never a unit)? */
function isReservedUnitWord(value) {
  const t = normalizeUnitCandidate(value);
  if (!t) return false;
  return RESERVED_UNIT_WORDS.has(t.replace(/-+/g, '-'));
}

/**
 * Format-only validation (no grounding): digit + length + charset + reserved.
 * Returns { valid, reason }.
 */
function isValidTrailerUnitFormat(value) {
  const unit = normalizeUnitCandidate(value);
  if (!unit) return { valid: false, reason: 'empty' };
  if (isReservedUnitWord(unit)) return { valid: false, reason: `reserved word "${unit}"` };
  if (!/\d/.test(unit)) return { valid: false, reason: 'no digit' };
  if (unit.length < 4 || unit.length > 20) return { valid: false, reason: `length ${unit.length} outside 4–20` };
  if (!/^[A-Z0-9-]+$/.test(unit)) return { valid: false, reason: 'invalid characters' };
  return { valid: true, reason: 'ok' };
}

/** Uppercased haystack with '#' and whitespace stripped, for exact matching. */
function normalizeHaystack(text) {
  return String(text || '').toUpperCase().replace(/[#\s]+/g, '');
}

/**
 * Does `unit` literally appear in `text` (comparison on normalized forms)?
 * Digit-only units additionally require the digits to appear as a standalone
 * "#123 / TRL 123"-style token in the RAW text, not merely as a substring of a
 * longer number (so unit "5829" is not "grounded" by "#58290").
 */
function unitAppearsInText(unit, text) {
  const u = normalizeUnitCandidate(unit);
  if (!u || !text) return false;
  if (!normalizeHaystack(text).includes(u)) return false;
  if (/^\d+$/.test(u)) {
    // Digit-only: require a standalone occurrence in the raw text.
    const re = new RegExp(`(?:^|[^0-9A-Za-z])${u}(?:[^0-9A-Za-z]|$)`);
    if (!re.test(String(text))) return false;
  }
  return true;
}

/**
 * Is a DIGIT-ONLY unit attached to a non-trailer label in this text?
 * "Home Depot MDO/DFC #5829" / "Load #9492869" / "Door #25" → true for those
 * numbers. Letter+digit units (SWFZ233611) are never facility numbers.
 */
function isNonTrailerContextNumber(unit, text) {
  const u = normalizeUnitCandidate(unit);
  if (!u || !/^\d+$/.test(u) || !text) return false;
  const raw = String(text);
  const re = new RegExp(`#?\\s*${u}(?![0-9])`, 'g');
  let sawTrailerLabelled = false;
  let sawNonTrailerLabelled = false;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const before = raw.slice(Math.max(0, m.index - 40), m.index).replace(/[#:\s]+$/, ' ').trimEnd();
    if (TRAILER_LABEL_RE.test(before)) sawTrailerLabelled = true;
    else if (NON_TRAILER_NUMBER_LABEL_RE.test(before)) sawNonTrailerLabelled = true;
  }
  // Facility-labelled and never trailer-labelled → reject as a trailer unit.
  return sawNonTrailerLabelled && !sawTrailerLabelled;
}

/**
 * Full validation: format + exact grounding in a real source.
 *
 * `groundedSources` may contain:
 *   currentText, currentCaption, repliedText, repliedCaption : strings
 *   visionUnits : array of vision-extracted unit strings (already verified
 *                 against image pixels by the vision service)
 *
 * Returns { valid, reason, source } where source ∈
 *   'current_text' | 'current_caption' | 'replied_text' | 'replied_caption'
 *   | 'current_image' | 'replied_image' | null.
 */
function validateTrailerUnit(value, groundedSources = {}) {
  const fmt = isValidTrailerUnitFormat(value);
  if (!fmt.valid) return { valid: false, reason: fmt.reason, source: null };
  const unit = normalizeUnitCandidate(value);

  const textSources = [
    ['current_text', groundedSources.currentText],
    ['current_caption', groundedSources.currentCaption],
    ['replied_text', groundedSources.repliedText],
    ['replied_caption', groundedSources.repliedCaption],
  ];
  for (const [source, text] of textSources) {
    if (!unitAppearsInText(unit, text)) continue;
    if (isNonTrailerContextNumber(unit, text)) {
      return { valid: false, reason: `"${unit}" is a facility/load/door-style number in ${source}`, source: null };
    }
    return { valid: true, reason: 'ok', source };
  }

  // Vision-extracted units (already pixel-verified by the vision service).
  const visionLists = [
    ['current_image', groundedSources.currentImageUnits || []],
    ['replied_image', groundedSources.repliedImageUnits || groundedSources.visionUnits || []],
  ];
  for (const [source, list] of visionLists) {
    for (const v of Array.isArray(list) ? list : []) {
      const candidate = typeof v === 'string' ? v : v && v.value;
      if (normalizeUnitCandidate(candidate) === unit) return { valid: true, reason: 'ok', source };
    }
  }

  return { valid: false, reason: 'not grounded in any source', source: null };
}

module.exports = {
  RESERVED_UNIT_WORDS,
  normalizeUnitCandidate,
  isReservedUnitWord,
  isValidTrailerUnitFormat,
  isNonTrailerContextNumber,
  unitAppearsInText,
  validateTrailerUnit,
};
