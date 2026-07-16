/**
 * Pure shaping/labelling helpers for trailer monitor events.
 *
 * Extracted from services/trailerMonitorService.js, which re-exports them so
 * existing callers and tests keep working. Everything here is PURE — no I/O, no
 * database, no Telegram — which keeps the orchestration in the monitor service
 * focused and makes these rules trivially testable.
 */
'use strict';

/** Display name for a Telegram `from` object: real name, else @username. */
function reporterName(from) {
  if (!from) return null;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return name || (from.username ? `@${from.username}` : null);
}

/** Human label for an event type. */
function eventLabel(type) {
  return type === 'pickup' ? 'pickup' : 'drop-off';
}

/**
 * Short possession+cargo phrase for a confirmation line, e.g. "with driver",
 * "dropped empty", "dropped loaded". Cargo is only shown when known.
 */
function statePhrase(event) {
  const p = event.possession_status;
  const c = event.cargo_status;
  const pLabel = p === 'with_driver' ? 'with driver' : p === 'dropped' ? 'dropped' : 'unknown';
  if (c === 'empty') return `${pLabel} empty`;
  if (c === 'loaded') return `${pLabel} loaded`;
  return pLabel;
}

/** Map a parsed.semantic block to the trailer_events audit columns. */
function semanticColumns(parsed, verificationStatus) {
  const sem = parsed.semantic || null;
  if (!sem) return { ai_verification_status: verificationStatus || null };
  return {
    semantic_intent: sem.intent || null,
    semantic_completed: sem.completed != null ? Boolean(sem.completed) : null,
    semantic_confidence: sem.confidence != null ? sem.confidence : null,
    semantic_reason: sem.reason || null,
    unit_grounded: sem.unitGrounded != null ? Boolean(sem.unitGrounded) : null,
    unit_source: sem.unitSource || null,
    unit_evidence: sem.unitEvidence || null,
    action_evidence: sem.actionEvidence || null,
    ai_model: sem.aiModel || null,
    ai_verified_at: sem.verifiedAt || null,
    ai_verification_status: verificationStatus || null,
    raw_ai_result: sem.raw || null,
  };
}

module.exports = { reporterName, eventLabel, statePhrase, semanticColumns };
