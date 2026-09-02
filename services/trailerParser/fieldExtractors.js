/**
 * Pulling individual FIELDS out of a driver's trailer message — pure functions.
 *
 * `extractUnitNumber` is the sharp edge: it must never return a reserved word
 * ("TRL", "TRAILER", "UNIT") or a number that belongs to some other context,
 * because a wrong unit silently attaches an event to the wrong trailer. The
 * format rules and the non-trailer-number guard both live in
 * services/trailerUnitValidation.js and are applied here.
 *
 * Split out of services/trailerMessageParser.js, which re-exports these.
 */
const {
  isValidTrailerUnitFormat,
  isNonTrailerContextNumber,
} = require('../trailerUnitValidation');
const { normalizeUnitNumber } = require('../../lib/trailers/normalize');
const {
  TRAILER_KEYWORDS, CONDITION_KEYWORDS, LOADED_PATTERNS, EMPTY_PATTERNS, norm,
} = require('./vocabulary');

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

module.exports = {
  hasTrailerKeyword,
  extractUnitNumber,
  extractLocation,
  extractCondition,
  extractDate,
  extractReportedDriverName,
  extractAddressLine,
};
