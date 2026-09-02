/**
 * Deciding WHAT HAPPENED in a trailer message — pure functions.
 *
 * Pickup vs drop-off, whether the driver is reporting a completed action or
 * being given an instruction, and whether cargo changed hands. The distinction
 * matters: an instruction must not be recorded as a completed trailer event.
 *
 * Split out of services/trailerMessageParser.js, which re-exports these.
 */
const {
  PICKUP_PHRASES, DROPOFF_PHRASES, MULTILINGUAL_PICKUP_HINTS, MULTILINGUAL_DROPOFF_HINTS,
  DROPOFF_INSTRUCTION_PATTERNS, PICKUP_INSTRUCTION_PATTERNS, COMPLETION_SIGNAL_RE,
  LOADED_PATTERNS, EMPTY_PATTERNS, norm,
} = require('./vocabulary');

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

module.exports = {
  detectMultilingualActionHint,
  detectAction,
  hasCompletionSignal,
  detectInstructionPhrase,
  detectCargoSignal,
  resolveCargoPossession,
};
