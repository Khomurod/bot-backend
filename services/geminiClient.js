// services/geminiClient.js — shared Gemini generateContent with model fallback
require('dotenv').config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const { runCapability } = require('./ai/router');

// A COMPATIBILITY FAÇADE over the router since Stage 5c. The direct fetch loop,
// its per-model retry and its backoff sleep were deleted rather than left
// beside the router — two live paths to one API is how the two stop agreeing,
// and the unexercised one is the one that rots. Response parsing, the timeout
// this client never had, and the gemini-3 temperature quirk now live in
// `services/ai/adapters/gemini.js`, the layer that knows the wire format. What
// stays here is the Gemini-shaped vocabulary its ~20 callers use.

const DEFAULT_GEMINI_TEXT_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-3.1-flash',
  'gemini-2.0-flash',
];

const GEMINI_TEXT_MODELS = parseGeminiModelList(
  process.env.GEMINI_TEXT_MODELS,
  DEFAULT_GEMINI_TEXT_MODELS
);


function parseGeminiModelList(envValue, fallbackList) {
  const fromEnv = String(envValue || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : [...fallbackList];
}

function uniqueGeminiModels(models) {
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

function resolveGeminiModels(opts = {}) {
  if (Array.isArray(opts.models) && opts.models.length > 0) {
    return uniqueGeminiModels(opts.models);
  }
  return [...GEMINI_TEXT_MODELS];
}

function stripJsonFences(text) {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function safeParseJsonObject(text) {
  const raw = stripJsonFences(text);
  try {
    const direct = JSON.parse(raw);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  } catch {
    // continue
  }
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const slice = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
      if (slice && typeof slice === 'object' && !Array.isArray(slice)) return slice;
    } catch {
      return null;
    }
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isGeminiQuotaExhaustedError(status, message) {
  const normalized = String(message || '').toLowerCase();
  return status === 429 && (
    normalized.includes('quota')
    || normalized.includes('resource_exhausted')
    || normalized.includes('limit')
    || normalized.includes('daily')
    || normalized.includes('exceeded')
  );
}

function isGeminiTransientError(status, message) {
  const normalized = String(message || '').toLowerCase();
  return status === 429
    || status === 503
    || status >= 500
    || normalized.includes('high demand')
    || normalized.includes('try again')
    || normalized.includes('temporarily unavailable');
}

/**
 * Low-level Gemini call with a model chain — now over the AI router.
 * @returns {{ text, model, payload }}
 *
 * WHAT THIS KEEPS. The signature, the `{ text, model, payload }` return, the
 * `attemptErrors[]` on failure, `validateResult`, and the two Gemini quirks that
 * are genuinely about Gemini: an empty candidate list is an ERROR rather than an
 * empty answer, and `gemini-3*` refuses an explicit temperature so one is only
 * defaulted for the older models (that one now lives in the adapter, which is
 * the layer that knows the wire format).
 *
 * WHAT IT GAINS. A timeout — this client has never had one, so a hung Gemini
 * request held a Telegram handler open indefinitely. Its key from the database,
 * inheriting `GEMINI_API_KEY` when unset. And a provider after it, which is why
 * `requireAdapter` is passed: a caller of THIS function has built Gemini-shaped
 * `contents`, so only a Gemini-adapter provider can serve it. The roster is
 * filtered rather than the request quietly reshaped.
 */
async function callGeminiGenerateContent(opts = {}) {
  // Only what the caller actually named. `resolveGeminiModels` falls back to
  // GEMINI_TEXT_MODELS, and passing those as a preference would put six
  // hardcoded model names in front of the admin's chain on every call — the
  // Settings → AI model list would never be reached.
  const models = Array.isArray(opts.models) && opts.models.length
    ? uniqueGeminiModels(opts.models)
    : null;

  try {
    const result = await runCapability({
      capability: opts.capability || null,
      requireAdapter: 'gemini',
      preferProvider: 'gemini',
      preferModels: models,
      contents: opts.contents,
      systemInstruction: opts.systemInstruction || null,
      generationConfig: opts.generationConfig || {},
      systemText: null,
      validate: typeof opts.validateResult === 'function' ? opts.validateResult : null,
      timeoutMs: opts.timeoutMs ?? null,
    });
    return { text: result.text, model: result.model, payload: result.payload || {} };
  } catch (err) {
    throw asLegacyGeminiFailure(err, models || resolveGeminiModels(opts));
  }
}

/** The `{ model, status, message }[]` shape every Gemini caller already reads. */
function asLegacyGeminiFailure(err, models) {
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

/**
 * A text (or JSON) request that used to go to Gemini alone.
 *
 * SINCE 23 OCTOBER 2026 IT GOES TO THE WHOLE ROSTER, in the admin's order, like
 * every other request: the owner wants the free models to try first and Claude
 * to settle what they are not sure of (services/ai/escalation.js). The models a
 * caller names stay a preference for Gemini's own chain. Pictures go only to a
 * model that can see them (lib/ai/vision.js). Callers that build Gemini-native
 * `contents` themselves still use callGeminiGenerateContent, which stays on
 * Gemini.
 */
async function callGeminiText(opts = {}) {
  const models = Array.isArray(opts.models) && opts.models.length
    ? uniqueGeminiModels(opts.models)
    : null;
  const json = /json/i.test(String(opts.responseMimeType || ''));
  const { responseMimeType: _ignored, maxOutputTokens: configuredMax, ...extraConfig } = opts.generationConfig || {};
  try {
    const result = await runCapability({
      // Which business decision this call serves — and what decides whether
      // an unsure answer is checked by Claude.
      capability: opts.capability || null,
      preferProvider: 'gemini',
      preferModels: models,
      systemText: opts.systemText ? String(opts.systemText) : null,
      userText: opts.userText != null ? String(opts.userText) : String(opts.promptText || ''),
      extraParts: opts.extraParts?.length ? opts.extraParts : null,
      generationConfig: Object.keys(extraConfig).length ? extraConfig : null,
      expects: json ? 'json' : 'text',
      validate: typeof opts.validateResult === 'function' ? (text) => opts.validateResult(text) : null,
      timeoutMs: opts.timeoutMs ?? null,
      generation: { maxTokens: opts.maxOutputTokens ?? configuredMax ?? 800 },
      // What to ask the owner if the answer is still not sure after Claude
      // (services/ai/learning). Absent for every caller that does not say.
      learning: opts.learning || null,
    });
    return {
      text: result.text,
      model: result.model,
      payload: result.payload || {},
      provider: result.provider || null,
      stage: result.stage || null,
      confidence: result.confidence ?? null,
      uncertain: result.uncertain === true,
    };
  } catch (err) {
    throw asLegacyGeminiFailure(err, models || resolveGeminiModels(opts));
  }
}

async function callGeminiJson(opts = {}) {
  const userValidateParsed = opts.validateParsed;
  const result = await callGeminiText({
    ...opts,
    responseMimeType: opts.responseMimeType || 'application/json',
    validateResult: (text) => {
      const parsed = safeParseJsonObject(text);
      if (!parsed) {
        return { message: 'Gemini returned non-JSON output' };
      }
      if (typeof userValidateParsed === 'function' && userValidateParsed(parsed) !== true) {
        return { message: 'Gemini JSON failed validation' };
      }
      return true;
    },
  });
  const parsed = safeParseJsonObject(result.text);
  return {
    parsed,
    text: result.text,
    model: result.model,
    payload: result.payload,
    provider: result.provider,
    stage: result.stage,
    confidence: result.confidence,
    uncertain: result.uncertain,
  };
}

module.exports = {
  GEMINI_API_KEY,
  asLegacyGeminiFailure,
  GEMINI_TEXT_MODELS,
  parseGeminiModelList,
  safeParseJsonObject,
  stripJsonFences,
  isGeminiQuotaExhaustedError,
  isGeminiTransientError,
  callGeminiGenerateContent,
  callGeminiText,
  callGeminiJson,
};
