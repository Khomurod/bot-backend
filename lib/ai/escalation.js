'use strict';

/**
 * When a free model's answer is not good enough, and who is asked next. Pure.
 *
 * THE OWNER'S RULE (23 October 2026): the free models try first. If they are
 * at least 85% sure, their answer stands. If they are less sure — or the
 * answer says it could not tell — Claude is asked: Sonnet, and Haiku when
 * Sonnet cannot answer. If Claude cannot be reached, another strong (paid)
 * model is asked. If nobody better answers, the best answer there is comes
 * back marked `uncertain`, and the consumer's own gates decide what to do with
 * an unsure answer — which, for everything that changes stored state, is
 * nothing.
 *
 * ONLY DECISIONS ESCALATE. A capability is on the list below because its
 * answer changes something (a home-time request opened, a stage proposed, a
 * reply understood). Text written for people — a birthday note, a translation
 * — has no "sure" to measure and stays on the free models. So do the batch
 * jobs whose answer is a list, not one decision (driver status over many
 * groups, chat labels): they have their own "ambiguity means no change" rule,
 * and sending every batch to Claude would cost far more than it settles.
 *
 * A MODEL'S OWN CONFIDENCE IS NOT TRUSTED ALONE. Models overstate it. So an
 * answer escalates when its confidence is under the bar, OR when it says it
 * could not tell ("unclear", "unknown"), OR when it gave no confidence at all
 * after being asked for one.
 */

const MIN_CONFIDENCE = 85;

/**
 * Capability → what in its answer means "I could not tell". A function of the
 * parsed JSON returning true when the answer is unsure regardless of its
 * confidence. Absent: confidence alone decides.
 */
const ESCALATING = Object.freeze({
  home_time_intent: null,
  home_time_dates: null,
  home_time_return_to_road: null,
  home_time_import: null,
  driver_profile_extraction: null,
  control_reply_reading: (p) => String(p.action || p.intent || '').toLowerCase() === 'unclear',
  safety_approval_reading: (p) => {
    const decisions = Array.isArray(p.decisions) ? p.decisions : [];
    return decisions.some((d) => String(d?.decision || '').toLowerCase() === 'unclear');
  },
  hiring_stage_reading: null,
  recruiting_knowledge_reading: null,
});

const CONFIDENCE_INSTRUCTION = 'In the same JSON, also include "confidence": a number from 0 to 100 saying '
  + 'how sure you are of this answer. Be honest: below 85 means a stronger model or a person will check it.';

function escalates(capability) {
  return Object.prototype.hasOwnProperty.call(ESCALATING, capability);
}

/**
 * Only ask for a confidence when the caller's prompt already defines one as a
 * JSON key (`"confidence": 0-100`, `"confidence": "high"|"medium"|"low"`).
 * A key, not the bare word: the prompts embed what drivers and candidates
 * wrote, and someone typing "confidence" must not decide whether the model is
 * asked for one.
 */
function needsConfidenceInstruction(promptText) {
  return !/["']confidence["']\s*:/i.test(String(promptText || ''));
}

/**
 * A confidence as a number from 0 to 100, or null. Models write it as 87,
 * "87", 0.87, "87%", or a word.
 */
function normaliseConfidence(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase();
    if (word === 'high') return 90;
    if (word === 'medium') return 60;
    if (word === 'low') return 30;
  }
  const n = Number(String(value).replace('%', '').trim());
  if (!Number.isFinite(n)) return null;
  const scaled = n > 0 && n <= 1 && !Number.isInteger(n) ? n * 100 : n;
  return Math.max(0, Math.min(100, scaled));
}

/**
 * @returns {{sure: boolean, confidence: number|null, why: string|null}}
 */
function assessAnswer(capability, parsed, { minConfidence = MIN_CONFIDENCE } = {}) {
  if (!parsed || typeof parsed !== 'object') return { sure: false, confidence: null, why: 'no_answer' };
  const unsure = ESCALATING[capability];
  if (typeof unsure === 'function') {
    let flagged = false;
    try { flagged = Boolean(unsure(parsed)); } catch (_) { flagged = false; }
    if (flagged) return { sure: false, confidence: normaliseConfidence(parsed.confidence), why: 'said_unclear' };
  }
  const confidence = normaliseConfidence(parsed.confidence);
  if (confidence === null) return { sure: false, confidence: null, why: 'no_confidence' };
  if (confidence < minConfidence) return { sure: false, confidence, why: 'low_confidence' };
  return { sure: true, confidence, why: null };
}

/** [family, ...version numbers] of a Claude model id, for "newest first". */
function claudeVersion(id) {
  const m = String(id).toLowerCase().match(/claude-(?:(opus|sonnet|haiku)-)?([\d-]+?)(?:-(opus|sonnet|haiku))?(?:-(\d{8}))?$/);
  if (!m) return null;
  const family = m[1] || m[3] || null;
  const nums = m[2].split('-').filter(Boolean).map(Number).filter((n) => n < 1000);
  return { family, nums, dated: Boolean(m[4]) };
}

function newer(a, b) {
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i += 1) {
    const x = a.nums[i] ?? 0;
    const y = b.nums[i] ?? 0;
    if (x !== y) return x > y;
  }
  return !a.dated && b.dated; // an alias over a dated snapshot of the same version
}

/**
 * The models to ask at Claude: the newest Sonnet, then the newest Haiku
 * (the owner, 23 October 2026: "Sonnet, or Haiku — not Opus"). Falls back to
 * the provider's own chain, without Opus, when neither family is known to it.
 */
function claudeEscalationChain(modelIds, configuredChain = []) {
  const ids = [...new Set([...(configuredChain || []), ...(modelIds || [])].map(String))];
  const best = {};
  for (const id of ids) {
    const v = claudeVersion(id);
    if (!v || (v.family !== 'sonnet' && v.family !== 'haiku')) continue;
    if (!best[v.family] || newer(v, best[v.family].v)) best[v.family] = { id, v };
  }
  const chain = [best.sonnet?.id, best.haiku?.id].filter(Boolean);
  if (chain.length) return chain;
  return (configuredChain || []).map(String).filter((id) => claudeVersion(id)?.family !== 'opus');
}

module.exports = {
  MIN_CONFIDENCE,
  ESCALATING,
  CONFIDENCE_INSTRUCTION,
  escalates,
  needsConfidenceInstruction,
  normaliseConfidence,
  assessAnswer,
  claudeEscalationChain,
};
