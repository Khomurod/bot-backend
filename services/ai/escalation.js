'use strict';

/**
 * Free models first; Claude when they are not sure; another strong model when
 * Claude cannot be reached. The owner's rule of 23 October 2026 — see
 * lib/ai/escalation.js for what "sure" means and which capabilities escalate.
 *
 *   1. FREE   providers marked free (Groq, Cerebras, Gemini's free tier, …),
 *             in the order the admin set. An answer at least 85% sure stands.
 *   2. CLAUDE Sonnet, then Haiku. Its answer stands, sure or not — it is the
 *             best reading there is, and an unsure one comes back marked so.
 *   3. STRONG any other paid provider, only when Claude could not answer.
 *
 * If nobody past step 1 answers, the free answer comes back marked
 * `uncertain`. It is never silently promoted to "sure": every consumer of a
 * decision already has its own gate for a low-confidence answer, and that gate
 * is what keeps an unsure answer from changing anything.
 *
 * This module never imports the router — the router hands it the function
 * that asks one tier — so the two cannot require each other.
 */

const {
  escalates, assessAnswer, claudeEscalationChain,
  CONFIDENCE_INSTRUCTION, needsConfidenceInstruction,
} = require('../../lib/ai/escalation');

const TIERS = Object.freeze({
  free: (p) => p.isFree === true && p.adapter !== 'anthropic',
  claude: (p) => p.adapter === 'anthropic',
  strong: (p) => p.isFree !== true && p.adapter !== 'anthropic',
});

/**
 * The caller's own instructions. Chat turns (user / assistant messages) are
 * left out: they are other people's words, not the caller's prompt.
 */
function promptText(args) {
  const fromSystem = Array.isArray(args.messages)
    ? args.messages.filter((m) => m?.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
    : '';
  return [args.systemText, args.userText, fromSystem].filter(Boolean).join('\n');
}

/** Ask for a confidence, unless the caller's own prompt already defines one. */
function withConfidence(args) {
  if (!needsConfidenceInstruction(promptText(args))) return args;
  if (Array.isArray(args.messages) && args.messages.length) {
    return { ...args, messages: [{ role: 'system', content: CONFIDENCE_INSTRUCTION }, ...args.messages] };
  }
  if (args.systemText) return { ...args, systemText: `${args.systemText}\n\n${CONFIDENCE_INSTRUCTION}` };
  return { ...args, userText: `${args.userText || ''}\n\n${CONFIDENCE_INSTRUCTION}` };
}

function parsedOf(result) {
  if (result?.parsed && typeof result.parsed === 'object') return result.parsed;
  try {
    const text = String(result?.text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function tagged(result, stage, assessment) {
  return {
    ...result,
    stage,
    confidence: assessment.confidence,
    uncertain: !assessment.sure,
    uncertainWhy: assessment.sure ? null : assessment.why,
  };
}

function unavailable(err) {
  return Boolean(err && err.aiUnavailable);
}

/**
 * @param {object} args          runCapability's arguments
 * @param {Function} askTier     (args) => Promise<result>; the router's one-pass runner
 * @returns {Promise<object>} the router's result, plus {stage, confidence, uncertain}
 */
async function runEscalated(args, askTier) {
  // Not a decision, a Gemini-native request, or a caller that pinned an
  // adapter: one pass over the roster, exactly as before.
  if (!escalates(args.capability) || args.contents || args.requireAdapter || args.expects !== 'json') {
    return askTier(args);
  }
  const asked = withConfidence(args);
  const assess = (result) => {
    const parsed = parsedOf(result);
    // No JSON object at all (nothing parseable, or a bare list) is not a
    // sure answer: every escalating capability answers with one object.
    return assessAnswer(args.capability, Array.isArray(parsed) ? null : parsed);
  };

  let free = null;
  let freeFailure = null;
  try {
    free = await askTier({ ...asked, providerFilter: TIERS.free });
  } catch (err) {
    if (!unavailable(err)) throw err;
    freeFailure = err;
  }
  const freeAssessment = free ? assess(free) : null;
  if (free && freeAssessment.sure) return tagged(free, 'free', freeAssessment);

  for (const [stage, filter, chainOverride] of [
    ['claude', TIERS.claude, (p) => claudeEscalationChain(p.discoveredModelIds, p.modelChain)],
    ['strong', TIERS.strong, null],
  ]) {
    try {
      const better = await askTier({ ...asked, providerFilter: filter, chainOverride });
      return tagged(better, stage, assess(better));
    } catch (err) {
      if (!unavailable(err)) throw err;
    }
  }

  if (free) return tagged(free, 'free', freeAssessment);
  throw freeFailure;
}

module.exports = { runEscalated, withConfidence, TIERS };
