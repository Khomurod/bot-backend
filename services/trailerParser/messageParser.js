/**
 * Parsing ONE trailer message into a single structured result.
 *
 * Composes the field extractors and action detectors into the shape the trailer
 * monitor consumes. Multi-trailer messages go through ./eventParser.js instead.
 *
 * Split out of services/trailerMessageParser.js, which re-exports this.
 */
const { normalizeUnitNumber } = require('../trailerMasterList/normalize');
const { norm } = require('./vocabulary');
const {
  hasTrailerKeyword, extractUnitNumber, extractLocation, extractCondition, extractDate,
  extractReportedDriverName, extractAddressLine,
} = require('./fieldExtractors');
const {
  detectAction, detectMultilingualActionHint, detectInstructionPhrase, hasCompletionSignal,
  detectCargoSignal, resolveCargoPossession,
} = require('./actionDetectors');

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

module.exports = {
  parseTrailerMessage,
};
