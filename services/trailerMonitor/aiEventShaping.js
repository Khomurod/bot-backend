'use strict';

/**
 * Turning an AI verification result into the row shape the ledger stores.
 *
 * Pure functions: no database, no Telegram, no network. One builder per
 * outcome — verified, needs-review, planned — plus the bounded, prompt-free
 * copy of the AI result kept for audit.
 */

const { detectAction, detectMultilingualActionHint } = require('../trailerMessageParser');

/**
 * Could this deterministic parse become a pickup/drop-off? Any action signal —
 * deterministic action, English action phrase, or a multilingual (uz/ru)
 * action hint — makes the message a state-change candidate that REQUIRES
 * semantic verification.
 */
function hasPotentialAction(parsedList, text) {
  if (parsedList.some((p) => p.eventType === 'pickup' || p.eventType === 'dropoff' || p.action)) return true;
  return Boolean(detectAction(text) || detectMultilingualActionHint(text));
}

/** Business-rule cargo for a VERIFIED event: AI explicit → deterministic → default. */
function resolveVerifiedCargo(aiEvent, detMatch) {
  if (aiEvent.cargoStatus === 'loaded' || aiEvent.cargoStatus === 'empty') return aiEvent.cargoStatus;
  if (detMatch && (detMatch.cargoStatus === 'loaded' || detMatch.cargoStatus === 'empty')) return detMatch.cargoStatus;
  return aiEvent.action === 'dropoff' ? 'empty' : 'unknown';
}

/**
 * Build the registration payload for one AI-verified event, backfilling
 * concrete fields (location/condition/date/reported name) from the matching
 * deterministic segment when the AI left them null.
 */
function buildVerifiedParsed(aiResult, aiEvent, parsedList, eventIndex) {
  const detMatch = parsedList.find((p) => p.trailerUnit === aiEvent.trailerUnit)
    || (parsedList.length === 1 ? parsedList[0] : null);
  const action = aiEvent.action; // gate guarantees pickup|dropoff
  return {
    isTrailerRelated: true,
    eventType: action,
    trailerUnit: aiEvent.trailerUnit,
    action,
    possessionStatus: action === 'pickup' ? 'with_driver' : 'dropped',
    cargoStatus: resolveVerifiedCargo(aiEvent, detMatch),
    locationText: aiEvent.locationText || detMatch?.locationText || null,
    conditionText: aiEvent.conditionText || detMatch?.conditionText || null,
    eventDateText: detMatch?.eventDateText || null,
    reportedDriverName: detMatch?.reportedDriverName || null,
    confidence: aiEvent.confidence,
    reason: aiEvent.reason || 'AI-verified completed action',
    needsReview: false,
    method: 'semantic_ai',
    eventIndex,
    semantic: {
      intent: aiEvent.intent,
      completed: aiEvent.completed,
      confidence: aiEvent.confidence,
      reason: aiEvent.reason,
      unitGrounded: aiEvent.unitGrounded,
      unitSource: aiEvent.unitSource,
      unitEvidence: aiEvent.unitEvidence,
      actionEvidence: aiEvent.actionEvidence,
      aiModel: aiResult.aiModel || null,
      verifiedAt: new Date().toISOString(),
      raw: sanitizeAiResultForStorage(aiResult),
    },
  };
}

/** Review payload for one AI event that did NOT pass the gate. */
function buildReviewParsed(aiResult, aiEvent, gate, eventIndex) {
  return {
    isTrailerRelated: true,
    eventType: 'unidentified',
    trailerUnit: aiEvent.unitGrounded ? aiEvent.trailerUnit : null,
    action: null,
    locationText: aiEvent.locationText || null,
    conditionText: aiEvent.conditionText || null,
    eventDateText: null,
    reportedDriverName: null,
    confidence: aiEvent.confidence,
    reason: `${aiEvent.intent || aiResult.intent}: ${gate.reason}`,
    needsReview: true,
    method: 'semantic_ai',
    eventIndex,
    semantic: {
      intent: aiEvent.intent || aiResult.intent,
      completed: aiEvent.completed,
      confidence: aiEvent.confidence,
      reason: aiEvent.reason || gate.reason,
      unitGrounded: aiEvent.unitGrounded,
      unitSource: aiEvent.unitSource,
      unitEvidence: aiEvent.unitEvidence,
      actionEvidence: aiEvent.actionEvidence,
      aiModel: aiResult.aiModel || null,
      verifiedAt: new Date().toISOString(),
      raw: sanitizeAiResultForStorage(aiResult),
    },
  };
}

/**
 * Planned-instruction payload for one AI event classified as an assignment /
 * instruction (instruction_pickup/dropoff, planned_pickup/dropoff). Captures the
 * planned action + destination; it never becomes a completed event.
 */
function buildPlannedParsed(aiResult, aiEvent, eventIndex) {
  const action = aiEvent.action === 'pickup' || aiEvent.action === 'dropoff'
    ? aiEvent.action
    : ((aiEvent.intent || '').includes('pickup') ? 'pickup' : 'dropoff');
  return {
    isTrailerRelated: true,
    eventType: 'instruction',
    trailerUnit: aiEvent.trailerUnit,
    action,
    isInstruction: true,
    instructionAction: action,
    locationText: aiEvent.plannedLocation || aiEvent.locationText || null,
    confidence: aiEvent.confidence,
    reason: aiEvent.reason || `${aiEvent.intent || aiResult.intent} (instruction/assignment)`,
    method: 'semantic_ai',
    eventIndex,
    semantic: {
      intent: aiEvent.intent || aiResult.intent,
      completed: aiEvent.completed,
      confidence: aiEvent.confidence,
      reason: aiEvent.reason,
      unitGrounded: aiEvent.unitGrounded,
      unitSource: aiEvent.unitSource,
      unitEvidence: aiEvent.unitEvidence,
      actionEvidence: aiEvent.actionEvidence,
      aiModel: aiResult.aiModel || null,
      verifiedAt: new Date().toISOString(),
      raw: sanitizeAiResultForStorage(aiResult),
    },
  };
}

/** Bounded, prompt-free copy of the normalized AI result for the audit column. */
function sanitizeAiResultForStorage(aiResult) {
  if (!aiResult || aiResult.status !== 'ok') return null;
  return {
    intent: aiResult.intent,
    action: aiResult.action,
    completed: aiResult.completed,
    language: aiResult.language,
    needsReview: aiResult.needsReview,
    trailerEvents: (aiResult.trailerEvents || []).map((e) => ({
      trailerUnit: e.trailerUnit,
      intent: e.intent,
      action: e.action,
      completed: e.completed,
      unitGrounded: e.unitGrounded,
      unitSource: e.unitSource,
      unitEvidence: e.unitEvidence,
      actionEvidence: e.actionEvidence,
      possessionStatus: e.possessionStatus,
      cargoStatus: e.cargoStatus,
      confidence: e.confidence,
      reason: e.reason,
    })),
  };
}

module.exports = {
  hasPotentialAction,
  resolveVerifiedCargo,
  buildVerifiedParsed,
  buildReviewParsed,
  buildPlannedParsed,
  sanitizeAiResultForStorage,
};
