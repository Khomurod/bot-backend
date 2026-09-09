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

/** Prompt → the shape this provider's wire format wants. */
function buildRequest(provider, { systemText, userText, messages, generationConfig }) {
  if (provider.adapter === 'gemini') {
    return {
      contents: [{ role: 'user', parts: [{ text: userText || '' }] }],
      systemInstruction: systemText ? { parts: [{ text: systemText }] } : null,
      generationConfig: generationConfig || {},
    };
  }
  const built = messages || [
    ...(systemText ? [{ role: 'system', content: systemText }] : []),
    { role: 'user', content: userText || '' },
  ];
  return { messages: built };
}

async function callOne(provider, model, request, { timeoutMs, expects }) {
  if (provider.adapter === 'gemini') {
    return callGeminiGenerate({
      apiKey: provider.apiKey,
      model,
      contents: request.contents,
      systemInstruction: request.systemInstruction,
      generationConfig: expects === 'json'
        ? { ...request.generationConfig, responseMimeType: 'application/json' }
        : request.generationConfig,
      timeoutMs,
    });
  }
  return callOpenAiChat({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    messages: request.messages,
    responseFormat: expects === 'json' ? { type: 'json_object' } : null,
    timeoutMs,
  });
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
  expects = 'text', validate = null, timeoutMs = null,
} = {}) {
  const roster = await getRoster();
  if (!roster.available) {
    await recordAiCall({ capabilityKey: capability, outcome: 'skipped' });
    throw new AiUnavailableError('AI is switched off or no provider is configured');
  }

  const { settings } = roster;
  const ordered = eligibleProviders(roster.providers, {
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
        provider: provider.providerKey, model: null,
        kind: FAILURE.CREDENTIAL, message: 'no key configured',
      });
      continue;
    }

    const request = buildRequest(provider, { systemText, userText, messages });
    const chain = provider.modelChain.length ? provider.modelChain : [null];

    for (const model of chain) {
      if (!model) continue;
      attempts += 1;
      const startedAt = Date.now();
      try {
        const result = await callOne(provider, model, request, {
          timeoutMs: timeoutMs || settings.requestTimeoutMs, expects,
        });

        let parsed = null;
        if (expects === 'json') {
          try {
            parsed = JSON.parse(stripFences(result.text));
          } catch {
            const bad = invalidResponse('Response was not valid JSON');
            attemptErrors.push({
              provider: provider.providerKey, model, kind: bad.kind, message: bad.reason,
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
              provider: provider.providerKey, model, kind: bad.kind, message: bad.reason,
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
          text: result.text, parsed, provider: provider.providerKey,
          model: result.model, attempts,
        };
      } catch (err) {
        const verdict = classifyFailure({
          status: err.status ?? null, message: err.message, code: err.code,
        });
        attemptErrors.push({
          provider: provider.providerKey, model, kind: verdict.kind, message: err.message,
        });
        await recordAiCall({
          capabilityKey: capability, providerKey: provider.providerKey, model,
          outcome: 'failed', failureKind: verdict.kind, latencyMs: Date.now() - startedAt,
          attempts, errorMessage: err.message,
        });

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

module.exports = { AiUnavailableError, runCapability, buildRequest, stripFences };
