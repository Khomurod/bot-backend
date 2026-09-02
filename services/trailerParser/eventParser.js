/**
 * Parsing a MULTI-TRAILER message into one event per unit.
 *
 * One post can mention several trailers ("dropped 403279, picked up 511824"), so
 * the text is segmented per unit token and each segment parsed on its own.
 * `shouldUseAiFallback` decides when the deterministic pass is too uncertain to
 * trust — the trailer monitor then fails closed to AI review rather than
 * guessing (docs/architecture/trailer-invariants.md).
 *
 * Split out of services/trailerMessageParser.js, which re-exports these.
 */
const {
  isValidTrailerUnitFormat, isNonTrailerContextNumber,
} = require('../trailerUnitValidation');
const { normalizeUnitNumber } = require('../../lib/trailers/normalize');
const { norm } = require('./vocabulary');
const {
  hasTrailerKeyword, extractLocation, extractCondition, extractDate,
  extractReportedDriverName, extractAddressLine,
} = require('./fieldExtractors');
const {
  detectAction, detectMultilingualActionHint, detectInstructionPhrase, hasCompletionSignal,
  detectCargoSignal, resolveCargoPossession,
} = require('./actionDetectors');
const { parseTrailerMessage } = require('./messageParser');

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
  findUnitTokens,
  parseTrailerMessageEvents,
  shouldUseAiFallback,
};
