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
 * A TASK WITH ITS OWN PROVIDERS (Settings → AI, migration 0107 — the CDL
 * reading first) is escalated along THE OWNER'S LIST instead of the tiers:
 * the first provider is asked; a sure answer stands; an unsure one is asked
 * of the next provider on the list; the last answer standing comes back
 * marked `uncertain` when nobody was sure. "Gemini, then Claude" is exactly
 * the free-then-Claude rule, and "only Claude" asks Claude alone (Sonnet,
 * then Haiku, as at the Claude tier).
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
 * The caller's own instructions, as they will actually be sent. With
 * `messages`, requestShape sends those and drops systemText / userText, so
 * only the system turns count; chat turns (user / assistant) are other
 * people's words, not the caller's prompt.
 */
function promptText(args) {
  if (Array.isArray(args.messages) && args.messages.length) {
    return args.messages.filter((m) => m?.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  }
  return [args.systemText, args.userText].filter(Boolean).join('\n');
}

/**
 * The owner's lessons for this kind of decision (services/ai/learning), after
 * the caller's own instructions — as a system message when the caller sent
 * `messages`, since requestShape then drops systemText.
 */
function withLessons(args, lessons) {
  if (!lessons) return args;
  if (Array.isArray(args.messages) && args.messages.length) {
    let at = 0;
    while (at < args.messages.length && args.messages[at]?.role === 'system') at += 1;
    return {
      ...args,
      messages: [...args.messages.slice(0, at), { role: 'system', content: lessons }, ...args.messages.slice(at)],
    };
  }
  return { ...args, systemText: args.systemText ? `${args.systemText}\n\n${lessons}` : lessons };
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
 * The owner's list, one provider at a time: a sure answer stands, an unsure
 * one passes to the next provider; the last answer comes back marked.
 */
async function alongOwnOrder(asked, askTier, { assess, finish }) {
  let last = null;
  let failure = null;
  for (const key of asked.providerOrder) {
    let answer;
    try {
      // eslint-disable-next-line no-await-in-loop
      answer = await askTier({
        ...asked,
        providerFilter: (p) => p.providerKey === key,
        chainOverride: (p) => (TIERS.claude(p) ? claudeEscalationChain(p.discoveredModelIds, p.modelChain) : p.modelChain || []),
      });
    } catch (err) {
      if (!unavailable(err)) throw err;
      failure = failure || err;
      continue;
    }
    const assessment = assess(answer);
    if (assessment.sure) return tagged(answer, 'chosen', assessment);
    last = { answer, assessment };
  }
  if (last) return finish(tagged(last.answer, 'chosen', last.assessment));
  throw failure;
}

/**
 * @param {object} args          runCapability's arguments. `args.learning`
 *   ({ context, ask, subjectKey? }) says what to ask the owner if the answer is
 *   still not sure at the end — see services/ai/learning/hooks.js.
 * @param {Function} askTier     (args) => Promise<result>; the router's one-pass runner
 * @param {object} [hooks]       { lessonsFor(capability), onUncertain(args, result) }
 * @returns {Promise<object>} the router's result, plus {stage, confidence, uncertain}
 */
async function runEscalated(args, askTier, hooks = {}) {
  // Not a decision, a Gemini-native request, or a caller that pinned an
  // adapter: one pass over the roster, exactly as before.
  if (!escalates(args.capability) || args.contents || args.requireAdapter || args.expects !== 'json') {
    return askTier(args);
  }
  // A task whose list is empty is asked once, so the router says "no provider is chosen".
  if (Array.isArray(args.providerOrder) && !args.providerOrder.length) return askTier(args);
  let lessons = '';
  try {
    lessons = hooks.lessonsFor ? await hooks.lessonsFor(args.capability) : '';
  } catch (_) {
    lessons = '';
  }
  const asked = withConfidence(withLessons(args, lessons));
  const finish = (result) => {
    if (result.uncertain && hooks.onUncertain) {
      try { hooks.onUncertain(args, result); } catch (_) { /* never the caller's problem */ }
    }
    return result;
  };
  const assess = (result) => {
    const parsed = parsedOf(result);
    // No JSON object at all (nothing parseable, or a bare list) is not a
    // sure answer: every escalating capability answers with one object.
    return assessAnswer(args.capability, Array.isArray(parsed) ? null : parsed);
  };
  if (Array.isArray(args.providerOrder)) return alongOwnOrder(asked, askTier, { assess, finish });

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
      return finish(tagged(better, stage, assess(better)));
    } catch (err) {
      if (!unavailable(err)) throw err;
    }
  }

  if (free) return finish(tagged(free, 'free', freeAssessment));
  throw freeFailure;
}

module.exports = {
  runEscalated, withConfidence, withLessons, TIERS,
};
