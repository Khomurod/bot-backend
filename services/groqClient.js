// services/groqClient.js
//
// A COMPATIBILITY FAÇADE over `services/ai/router.js` since Stage 5c. It owns
// no transport any more: the direct fetch loop, its request builder and its
// sleep/backoff were deleted rather than left beside the router, because two
// live paths to the same API is exactly how the two stop agreeing — and the one
// that is no longer exercised is the one that rots. What it still owns is the
// Groq-shaped vocabulary its callers use: the model chain from the environment,
// the rate-limit and auth predicates, and Groq's prose `retry-after` form.
//
// Shared Groq chat-completions client used by:
//   - aiAnalysisService.js   (legacy company / driver reports)
//   - aiAnnotationService.js (per-message classifier)
//   - aiInsightsService.js   (narrative generation)
//   - datUiInspectorService.js (DAT layout inspector)
//   - dispatchPinnedContextService.js / dispatchParserService.js
//
require('dotenv').config();

const { runCapability } = require('./ai/router');

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_AI_MODEL = process.env.GROQ_AI_MODEL || 'llama-3.3-70b-versatile';
const GROQ_AI_FAST_MODEL = process.env.GROQ_AI_FAST_MODEL || 'llama-3.1-8b-instant';

const DEFAULT_GROQ_FALLBACK_CHAIN = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'openai/gpt-oss-20b',
];

const GROQ_AI_FALLBACK_MODELS = parseModelList(
  process.env.GROQ_AI_FALLBACK_MODELS,
  DEFAULT_GROQ_FALLBACK_CHAIN
);

const DEFAULT_MAX_RETRY_WAIT_MS = 35_000;
const INTERACTIVE_MAX_RETRY_WAIT_MS = 8_000;

function parseModelList(envValue, fallbackList) {
  const fromEnv = String(envValue || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : [...fallbackList];
}

function uniqueModels(models) {
  const seen = new Set();
  const out = [];
  for (const m of models) {
    const key = String(m || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function resolveModelChain(opts = {}) {
  if (Array.isArray(opts.models) && opts.models.length > 0) {
    return uniqueModels(opts.models);
  }
  const primary = opts.model || GROQ_AI_MODEL;
  return uniqueModels([primary, ...GROQ_AI_FALLBACK_MODELS]);
}

function isAuthOrConfigError(message) {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('not configured')
    || m.includes('401')
    || m.includes('403')
    || m.includes('invalid api key')
    || m.includes('unauthorized')
  );
}

function isGroqRateLimitError(status, message) {
  return status === 429
    || status === 503
    || status >= 500
    || /rate limit/i.test(message || '')
    || /too many requests/i.test(message || '')
    || /service unavailable/i.test(message || '')
    || /try again/i.test(message || '');
}

function parseRetryAfterMs(response, errorMessage) {
  const header = response?.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }
  const bodyMatch = String(errorMessage || '').match(/try again in\s+([\d.]+)\s*s/i);
  if (bodyMatch) {
    const seconds = Number.parseFloat(bodyMatch[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }
  return 0;
}

/**
 * Only what the CALLER actually named — never the module's env defaults.
 *
 * `resolveModelChain` merges a caller's choice with `GROQ_AI_MODEL` and
 * `GROQ_AI_FALLBACK_MODELS`, which is right for a client that owns its chain and
 * wrong for one that does not. Passing that merged list as a preference would
 * put four hardcoded model names in front of the admin's configured chain on
 * every single call, and the Settings → AI model list would never be reached.
 * A caller that names nothing gets the roster's chain, which is the point.
 */
function requestedModels(opts) {
  if (Array.isArray(opts.models) && opts.models.length) return uniqueModels(opts.models);
  if (opts.model) return [String(opts.model)];
  return null;
}

/**
 * Ask for a completion, Groq first, and fall through to whatever else is on the
 * roster. Returns { text, model }.
 *
 * THE SIGNATURE AND THE FAILURE SHAPE ARE THE CONTRACT, and neither moved. All
 * ~22 call sites, and every deterministic fallback beneath them, keep working
 * unchanged — `err.attemptErrors` still carries `{ model, status, message }`
 * and `err.allRateLimited` is still the flag `aiAnnotationService` reads to
 * decide its cooldown. What changed is underneath: the transport is
 * `services/ai/router.js`, so the key comes from the database (NULL inheriting
 * the environment), the model chain is an admin setting, and a failure is
 * classified rather than guessed at.
 *
 * TWO REAL BEHAVIOUR CHANGES, both of them the point of Stage 5:
 *
 *   A dead Groq key no longer ends the call. `isAuthOrConfigError` used to
 *   abort the whole chain on 401/403, which with more than one provider turns
 *   one expired credential into a total AI outage. `lib/ai/classify.js` calls
 *   it CREDENTIAL: stop asking THIS provider, move to the next.
 *
 *   The models this caller names are a PREFERENCE, not the whole world. They go
 *   at the head of Groq's own chain — an interactive path asking for a fast
 *   model is a latency decision somebody made deliberately — and every provider
 *   after Groq uses its own configured chain, because a Groq model name means
 *   nothing to Gemini.
 */
async function callGroqWithFallback(promptText, opts = {}) {
  const preferModels = requestedModels(opts);

  try {
    const result = await runCapability({
      capability: opts.capability || null,
      preferProvider: 'groq',
      preferModels,
      systemText: opts.systemText || null,
      userText: promptText,
      messages: Array.isArray(opts.messages) && opts.messages.length ? opts.messages : null,
      expects: opts.responseFormat?.type === 'json_object' ? 'json' : 'text',
      validate: typeof opts.validateResult === 'function' ? opts.validateResult : null,
      timeoutMs: opts.timeoutMs ?? null,
      generation: {
        temperature: opts.temperature,
        maxTokens: opts.maxCompletionTokens ?? opts.maxTokens,
        seed: opts.seed,
      },
    });
    return { text: result.text, model: result.model };
  } catch (err) {
    throw asLegacyGroqFailure(err, preferModels || resolveModelChain(opts));
  }
}

/**
 * Re-shape a router failure into the one twenty-two call sites already read.
 *
 * `AiUnavailableError` carries everything needed; this is a rename, not a
 * translation. The one addition is `aiUnavailable`, so a consumer that wants to
 * tell "every provider is off" from "Groq said no" can, without any consumer
 * having to change to keep working.
 */
function asLegacyGroqFailure(err, models) {
  const attemptErrors = Array.isArray(err.attemptErrors) && err.attemptErrors.length
    ? err.attemptErrors.map((e) => ({
      model: e.model || e.provider || null,
      status: e.status ?? null,
      message: e.message,
      provider: e.provider || null,
      kind: e.kind || null,
    }))
    : [{ model: models[0] || null, status: null, message: err.message }];

  const failure = new Error(
    attemptErrors.map((e) => `${e.model}: ${e.message}`).join('; ') || err.message
  );
  failure.attemptErrors = attemptErrors;
  failure.allRateLimited = err.allRateLimited === true;
  failure.aiUnavailable = err.aiUnavailable === true;
  return failure;
}

/** Backward-compatible: returns text only, uses full fallback chain from opts.model or GROQ_AI_MODEL. */
async function callGroqRaw(promptText, opts = {}) {
  const { text } = await callGroqWithFallback(promptText, opts);
  return text;
}

module.exports = {
  callGroqRaw,
  callGroqWithFallback,
  asLegacyGroqFailure,
  requestedModels,
  isAuthOrConfigError,
  isGroqRateLimitError,
  parseRetryAfterMs,
  parseModelList,
  resolveModelChain,
  uniqueModels,
  GROQ_API_KEY,
  GROQ_AI_MODEL,
  GROQ_AI_FAST_MODEL,
  GROQ_AI_FALLBACK_MODELS,
  DEFAULT_MAX_RETRY_WAIT_MS,
  INTERACTIVE_MAX_RETRY_WAIT_MS,
};
