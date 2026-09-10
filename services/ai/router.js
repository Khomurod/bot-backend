/**
 * Ask the first provider that can answer, and stop when the list runs out.
 *
 * The whole loop, and every interesting decision in it comes from somewhere
 * else on purpose: `lib/ai/classify.js` says what kind of failure this was,
 * `lib/ai/cooldown.js` says how long to stop asking, and the adapters know only
 * how to make one call. This file is the sequencing.
 *
 * FOUR PROPERTIES IT MUST HAVE, each of which is a bug it is written to avoid:
 *
 *   IT CANNOT SPIN. Every provider is tried at most once per run, tracked by
 *   key rather than by count, so a roster that changes underneath cannot make
 *   the loop revisit anyone. ai-fallback's full-cycle guard, for the same
 *   reason it has one.
 *
 *   RUNNING OUT IS A NORMAL OUTCOME. `AiUnavailableError` is what a consumer
 *   catches to reach its deterministic path. It is not an exception in the
 *   "something is broken" sense — with every provider disabled, which is a
 *   supported mode, it is the ONLY outcome, and the application is expected to
 *   work.
 *
 *   A BAD ANSWER IS A PROVIDER FAILURE. If a capability declares `expects:
 *   'json'` or supplies a validator, output that fails is treated exactly like
 *   a refusal: try the next provider rather than hand a consumer malformed
 *   data. This matters far more across several free models than it did with
 *   one, because they differ widely in how reliably they honour a JSON
 *   instruction.
 *
 *   IT NEVER TAKES A PROVIDER OFF THE ROSTER. It writes `cooled_until`; it does
 *   not write `enabled`. Turning a provider off is a person's decision, and
 *   software quietly undoing an operator's configuration is the failure mode
 *   this separation exists to prevent.
 */
const { classifyFailure, invalidResponse, retryAfterMs, FAILURE } = require('../../lib/ai/classify');
const { cooldownFor, eligibleProviders } = require('../../lib/ai/cooldown');
const { getRoster, nextRotation } = require('./registry');
const aiProviders = require('../../database/aiProviders');
const { recordAiCall } = require('../../database/aiCallLog');
const { callOpenAiChat } = require('./adapters/openaiChat');
const { callGeminiGenerate } = require('./adapters/gemini');

/** Every provider was unusable, cooled, or refused. The consumer degrades. */
class AiUnavailableError extends Error {
  constructor(message, attemptErrors = []) {
    super(message || 'No AI provider could answer');
    this.name = 'AiUnavailableError';
    this.aiUnavailable = true;
    this.attemptErrors = attemptErrors;
    // Preserved for compatibility with the shape `aiAnnotationService` already
    // reads off a Groq failure, so its cooldown branch keeps working.
    this.allRateLimited = attemptErrors.length > 0
      && attemptErrors.every((e) => e.kind === FAILURE.QUOTA || e.kind === FAILURE.TRANSIENT);
  }
}

/**
 * OpenAI-shaped `messages` → Gemini's `contents` + `systemInstruction`.
 *
 * NOT a nicety. `requestPinnedContextFromGroq` and
 * `requestDispatchTemplateFromGroq` both call `callGroqWithFallback('')` and put
 * the entire document in `messages`. Without this, the moment the roster reached
 * a Gemini provider it would send `[{ parts: [{ text: '' }] }]` — an EMPTY
 * prompt — and a model asked nothing at all still returns well-formed JSON.
 * Both of those sites validate the SHAPE of the answer, not its truth, so a
 * guessed pickup address would have passed through as an extracted fact. A
 * confident wrong answer is worse than a failure, and this is how one gets made.
 */
function geminiTurnsFromMessages(messages, extraParts) {
  const systemParts = [];
  const turns = [];
  for (const m of messages) {
    const text = String(m?.content ?? '');
    if (m?.role === 'system') {
      systemParts.push({ text });
      continue;
    }
    turns.push({ role: m?.role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
  }
  const extras = extraParts || [];
  if (extras.length) {
    if (turns.length) turns[turns.length - 1].parts.push(...extras);
    else turns.push({ role: 'user', parts: [{ text: '' }, ...extras] });
  }
  return { systemParts, turns };
}

/** Prompt → the shape this provider's wire format wants. */
function buildRequest(provider, {
  systemText, userText, messages, contents, extraParts, generationConfig, systemInstruction,
}) {
  if (provider.adapter === 'gemini') {
    // A caller that built its own Gemini-shaped instruction keeps it; a caller
    // that passed plain text or OpenAI messages gets one built here.
    let builtContents = contents;
    let builtSystem = systemInstruction
      || (systemText ? { parts: [{ text: systemText }] } : null);

    if (!builtContents && Array.isArray(messages) && messages.length) {
      const { systemParts, turns } = geminiTurnsFromMessages(messages, extraParts);
      builtContents = turns.length ? turns : [{ role: 'user', parts: [{ text: '' }] }];
      if (!builtSystem && systemParts.length) builtSystem = { parts: systemParts };
    } else if (!builtContents) {
      builtContents = [{ role: 'user', parts: [{ text: userText || '' }, ...(extraParts || [])] }];
    }

    return {
      contents: builtContents,
      systemInstruction: builtSystem,
      generationConfig: generationConfig || {},
    };
  }
  const built = messages || [
    ...(systemText ? [{ role: 'system', content: systemText }] : []),
    { role: 'user', content: userText || '' },
  ];
  return { messages: built };
}

/**
 * A capability that cannot be served by every adapter says so, and the roster
 * is filtered rather than the request quietly downgraded.
 *
 * The one real case today is the home-time screenshot import, which sends
 * images as `extraParts`. An OpenAI-compatible chat provider would accept the
 * text half of that request and answer confidently about a screenshot it never
 * saw — a wrong answer that looks exactly like a right one. Better to have no
 * provider and let the consumer degrade.
 */
function requiredAdapterFor({ contents, extraParts, requireAdapter }) {
  if (requireAdapter) return requireAdapter;
  if (contents || (extraParts && extraParts.length)) return 'gemini';
  return null;
}

async function callOne(provider, model, request, { timeoutMs, expects, generation = {} }) {
  if (provider.adapter === 'gemini') {
    const config = { ...request.generationConfig };
    if (generation.temperature != null) config.temperature = generation.temperature;
    if (generation.maxTokens != null) config.maxOutputTokens = generation.maxTokens;
    if (expects === 'json') config.responseMimeType = 'application/json';
    return callGeminiGenerate({
      apiKey: provider.apiKey,
      model,
      contents: request.contents,
      systemInstruction: request.systemInstruction,
      generationConfig: config,
      timeoutMs,
    });
  }
  return callOpenAiChat({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    messages: request.messages,
    responseFormat: expects === 'json' ? { type: 'json_object' } : null,
    temperature: generation.temperature ?? 0.2,
    maxTokens: generation.maxTokens ?? 2000,
    seed: generation.seed ?? null,
    timeoutMs,
  });
}

/**
 * The models to ask THIS provider for, and nothing about which provider is asked.
 *
 * A caller naming a model made a latency decision on purpose — an interactive
 * path asking for a fast model — and moving model choice into the admin must not
 * silently discard it. So its models lead ITS OWN provider's chain, and every
 * other provider keeps its configured chain, because a Groq model name means
 * nothing to Gemini.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO IS REORDER THE ROSTER. An earlier version
 * moved the caller's preferred provider to the front, and since every one of the
 * ~22 legacy call sites sets `preferProvider: 'groq'`, that made the Settings →
 * AI `priority` column decorative and meant `round_robin` never rotated
 * anything: Groq's free allowance was burned first on every call regardless of
 * what an operator had configured. Provider order is the admin's decision.
 * `preferProvider` survives only as the key saying which provider these models
 * belong to.
 */
function chainFor(provider, { preferProvider, preferModels }) {
  const configured = provider.modelChain.length ? provider.modelChain : [];
  if (provider.providerKey !== preferProvider || !preferModels?.length) return configured;
  // A caller's preference the provider no longer LISTS is not asked for. The
  // chain refresh cannot retire what is not in the chain, but the provider's
  // own listing can say a model does not exist, and the router believes the
  // listing. An empty listing is absence of evidence and changes nothing.
  const listed = Array.isArray(provider.discoveredModelIds) && provider.discoveredModelIds.length
    ? new Set(provider.discoveredModelIds) : null;
  const seen = new Set();
  const out = [];
  for (const model of [...preferModels, ...configured]) {
    const key = String(model || '').trim();
    if (!key || seen.has(key)) continue;
    if (listed && !configured.includes(key) && !listed.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Who to tell when a provider says a model no longer exists.
 *
 * The router does not change chains — that is a routing decision with an audit
 * trail, and it belongs to the maintenance job, which confirms against the
 * provider's listing before retiring anything. This hook is how the router
 * says "you should look at this now" without depending on that job. A listener
 * that throws cannot fail the call it was told about.
 */
let modelRefusalListener = null;
function setModelRefusalListener(fn) {
  modelRefusalListener = typeof fn === 'function' ? fn : null;
}
function reportModelRefusal(detail) {
  if (!modelRefusalListener) return;
  try {
    const out = modelRefusalListener(detail);
    if (out && typeof out.catch === 'function') out.catch(() => {});
  } catch { /* the call must not fail because a listener did */ }
}

/** Strip a ```json fence, the way both existing clients already do. */
function stripFences(text) {
  return String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

/**
 * Run one capability through the roster.
 *
 * @param {object} args
 * @param {string} args.capability   a key from ai_capabilities, for the log
 * @param {string} [args.systemText]
 * @param {string} [args.userText]
 * @param {Array}  [args.messages]   OpenAI-shaped, if a caller has them already
 * @param {'text'|'json'} [args.expects='text']
 * @param {Function} [args.validate] (text, parsed) => true | {message}
 * @returns {Promise<{text, parsed, provider, model, attempts}>}
 * @throws {AiUnavailableError}
 */
async function runCapability({
  capability = null, systemText = null, userText = null, messages = null,
  contents = null, extraParts = null, generationConfig = null, systemInstruction = null,
  expects = 'text', validate = null, timeoutMs = null,
  preferProvider = null, preferModels = null, generation = null, requireAdapter = null,
} = {}) {
  const roster = await getRoster();
  if (!roster.available) {
    await recordAiCall({ capabilityKey: capability, outcome: 'skipped' });
    throw new AiUnavailableError('AI is switched off or no provider is configured');
  }

  const { settings } = roster;
  const needsAdapter = requiredAdapterFor({ contents, extraParts, requireAdapter });
  const usable = needsAdapter
    ? roster.providers.filter((p) => p.adapter === needsAdapter)
    : roster.providers;

  const ordered = eligibleProviders(usable, {
    now: Date.now(),
    freeOnly: settings.freeOnlyMode === true,
    roundRobin: settings.routingMode === 'round_robin',
    rotation: settings.routingMode === 'round_robin' ? nextRotation() : 0,
  });

  const attemptErrors = [];
  const tried = new Set();
  let attempts = 0;

  for (const provider of ordered) {
    // Tracked by key, not by index: the roster cannot make this revisit anyone.
    if (tried.has(provider.providerKey)) continue;
    tried.add(provider.providerKey);
    if (!provider.apiKey) {
      attemptErrors.push({
        provider: provider.providerKey, model: null, status: null,
        kind: FAILURE.CREDENTIAL, message: 'no key configured',
      });
      continue;
    }

    const request = buildRequest(provider, {
      systemText, userText, messages, contents, extraParts, generationConfig, systemInstruction,
    });
    const chain = chainFor(provider, { preferProvider, preferModels });
    if (!chain.length) {
      attemptErrors.push({
        provider: provider.providerKey, model: null, status: null,
        kind: FAILURE.CREDENTIAL, message: 'no models configured',
      });
      continue;
    }

    for (const model of chain) {
      attempts += 1;
      const startedAt = Date.now();
      try {
        const result = await callOne(provider, model, request, {
          timeoutMs: timeoutMs || settings.requestTimeoutMs,
          expects,
          generation: generation || {},
        });

        let parsed = null;
        if (expects === 'json') {
          try {
            parsed = JSON.parse(stripFences(result.text));
          } catch {
            const bad = invalidResponse('Response was not valid JSON');
            attemptErrors.push({
              provider: provider.providerKey, model, status: null,
              kind: bad.kind, message: bad.reason,
            });
            await recordAiCall({
              capabilityKey: capability, providerKey: provider.providerKey, model,
              outcome: 'failed', failureKind: bad.kind, latencyMs: Date.now() - startedAt,
              attempts, errorMessage: bad.reason,
            });
            continue; // next model — a bad answer is a provider failure
          }
        }
        if (typeof validate === 'function') {
          const verdict = validate(result.text, parsed);
          if (verdict !== true) {
            const bad = invalidResponse(verdict?.message || 'Response failed validation');
            attemptErrors.push({
              provider: provider.providerKey, model, status: null,
              kind: bad.kind, message: bad.reason,
            });
            await recordAiCall({
              capabilityKey: capability, providerKey: provider.providerKey, model,
              outcome: 'failed', failureKind: bad.kind, latencyMs: Date.now() - startedAt,
              attempts, errorMessage: bad.reason,
            });
            continue;
          }
        }

        await aiProviders.recordSuccess(provider.providerKey);
        await recordAiCall({
          capabilityKey: capability, providerKey: provider.providerKey,
          model: result.model, outcome: 'ok', latencyMs: Date.now() - startedAt,
          promptTokens: result.usage?.prompt_tokens ?? result.usage?.promptTokenCount,
          completionTokens: result.usage?.completion_tokens ?? result.usage?.candidatesTokenCount,
          attempts,
        });
        return {
          text: result.text, parsed, payload: result.payload || null,
          provider: provider.providerKey, model: result.model, attempts,
        };
      } catch (err) {
        const verdict = classifyFailure({
          status: err.status ?? null, message: err.message, code: err.code,
        });
        attemptErrors.push({
          provider: provider.providerKey, model, status: err.status ?? null,
          kind: verdict.kind, message: err.message,
        });
        await recordAiCall({
          capabilityKey: capability, providerKey: provider.providerKey, model,
          outcome: 'failed', failureKind: verdict.kind, latencyMs: Date.now() - startedAt,
          attempts, errorMessage: err.message,
        });

        if (verdict.kind === FAILURE.MODEL) {
          // Skip this model, keep the provider, and let the maintenance job
          // confirm against the listing before anything is retired for good.
          reportModelRefusal({ providerKey: provider.providerKey, model, error: err.message });
          continue;
        }

        if (verdict.coolProvider) {
          const cooldown = cooldownFor({
            kind: verdict.kind,
            consecutiveFailures: (provider.consecutiveFailures || 0) + 1,
            retryAfterMs: retryAfterMs({
              headerValue: err.retryAfterHeader, message: err.message,
              maxMs: settings.maxRetryWaitMs,
            }),
          });
          if (cooldown.until) {
            await aiProviders.recordFailure(provider.providerKey, {
              message: err.message, cooldown,
            });
          }
        }
        // A dead key or a spent quota is the same answer from every model this
        // provider offers, so stop asking it and move on.
        if (verdict.kind === FAILURE.CREDENTIAL || verdict.kind === FAILURE.QUOTA) break;
      }
    }
  }

  throw new AiUnavailableError(
    attemptErrors.map((e) => `${e.provider}/${e.model}: ${e.message}`).join('; ')
      || 'No AI provider was eligible',
    attemptErrors
  );
}

module.exports = {
  AiUnavailableError, runCapability, buildRequest, stripFences,
  chainFor, requiredAdapterFor, geminiTurnsFromMessages, setModelRefusalListener,
};
