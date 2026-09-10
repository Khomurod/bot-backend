/**
 * Add OpenRouter → paste key → Connect. Everything else is Wenze's job.
 *
 * The old flow asked an administrator for a protocol, a Base URL and a
 * comma-separated model list, then let them find out at the next real call
 * whether any of it was right. This does, in order:
 *
 *   1. look the provider up in the catalogue (or take a Base URL for a custom one)
 *   2. ask the provider which models exist — which also proves the key
 *   3. keep the ones that can chat, choose an order, respect free-only mode
 *   4. make ONE cheap call to the head of the chain, so "connected" means
 *      "answered", not "saved"
 *   5. save the provider enabled, record what was discovered and chosen, seed
 *      the terms watcher with the provider's official pages
 *
 * and then says what happened in words an operator can act on. A failure names
 * the step: "API key is invalid" and "reachable, but no compatible free models"
 * are different problems with different fixes, and "could not tell what went
 * wrong" is what this replaces.
 *
 * Every collaborator is injectable through `deps` so the whole flow can be
 * tested with a stubbed provider and no database. Production passes nothing.
 */
const { getCatalogEntry, keyLooksLike } = require('../../../lib/ai/providerCatalog');
const { isChatCapable, freeStatusOf, selectModelChain } = require('../../../lib/ai/modelSelection');
const { classifyFailure, FAILURE } = require('../../../lib/ai/classify');

const TEST_PROMPT = 'Reply with the single word: ok';
const TEST_TIMEOUT_MS = 20_000;
const MAX_SMOKE_ATTEMPTS = 3;

/** Providers whose free status per model is a published fact, not a guess. */
const FREE_STATUS_KNOWN = new Set(['openrouter', 'groq', 'cerebras', 'nvidia']);

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    listModels: require('./modelDiscovery').listModels,
    callOpenAiChat: require('../adapters/openaiChat').callOpenAiChat,
    callGeminiGenerate: require('../adapters/gemini').callGeminiGenerate,
    aiProviders: require('../../../database/aiProviders'),
    aiSettings: require('../../../database/aiSettings'),
    aiPolicy: require('../../../database/aiPolicy'),
    modelEvents: require('../../../database/aiModelEvents'),
    invalidateRegistry: require('../registry').invalidateRegistry,
  };
  /* eslint-enable global-require */
}

function slugify(text) {
  return String(text || '').toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function failure(reason, message, extra = {}) {
  return { ok: false, reason, message, ...extra };
}

/** Resolve what we are connecting to, before any network call. */
function resolveTarget({ catalogKey, label, baseUrl, adapter, providerKey }) {
  const entry = getCatalogEntry(catalogKey);
  if (!entry) return { error: failure('unknown_provider', `Wenze does not know a provider called "${catalogKey}".`) };
  if (entry.key !== 'custom') {
    return {
      entry,
      target: {
        providerKey: entry.key, label: entry.label, adapter: entry.adapter,
        baseUrl: entry.baseUrl, isFree: entry.isFree, catalogKey: entry.key,
      },
    };
  }
  const url = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(url)) {
    return { error: failure('missing_base_url', 'A custom provider needs its API Base URL (https://…), for example https://api.example.com/v1.') };
  }
  let host = url;
  try { host = new URL(url).hostname; } catch { /* keep the raw string */ }
  const key = slugify(providerKey || label || host);
  if (!key) return { error: failure('missing_base_url', 'Could not derive a provider key from that URL — give it a label.') };
  return {
    entry,
    target: {
      providerKey: key, label: String(label || host).trim(), adapter: adapter === 'gemini' ? 'gemini' : 'openai_chat',
      baseUrl: url, isFree: false, catalogKey: 'custom',
    },
  };
}

function keyHint(entry, apiKey) {
  if (keyLooksLike(entry, apiKey)) return '';
  return ` This does not look like a ${entry.label} key — theirs start with "${entry.keyPrefix}".`;
}

async function smokeTest(target, apiKey, chain, deps) {
  const refused = [];
  let quota = null;
  for (const model of chain.slice(0, MAX_SMOKE_ATTEMPTS)) {
    const startedAt = Date.now();
    try {
      if (target.adapter === 'gemini') {
        await deps.callGeminiGenerate({
          apiKey, model, timeoutMs: TEST_TIMEOUT_MS, baseUrl: `${target.baseUrl}/models`,
          contents: [{ role: 'user', parts: [{ text: TEST_PROMPT }] }],
          generationConfig: { maxOutputTokens: 8 },
        });
      } else {
        await deps.callOpenAiChat({
          apiKey, model, baseUrl: target.baseUrl, timeoutMs: TEST_TIMEOUT_MS, maxTokens: 8,
          messages: [{ role: 'user', content: TEST_PROMPT }],
        });
      }
      return { tested: { model, latencyMs: Date.now() - startedAt }, refused, quota };
    } catch (err) {
      const verdict = classifyFailure({ status: err.status ?? null, message: err.message, code: err.code });
      if (verdict.kind === FAILURE.CREDENTIAL) return { credential: err.message, refused, quota };
      if (verdict.kind === FAILURE.QUOTA) { quota = err.message; return { tested: null, refused, quota }; }
      // MODEL ("decommissioned", model_not_found) is the refusal this exists to
      // catch; a generic request fault on this one model is treated the same way.
      if (verdict.kind === FAILURE.MODEL || verdict.kind === FAILURE.FATAL_REQUEST) {
        refused.push({ model, error: err.message });
        continue;
      }
      // Transient or unknown: the model may be fine and the provider busy. Try the next one.
      refused.push({ model, error: err.message, transient: true });
    }
  }
  return { tested: null, refused, quota, exhausted: true };
}

function summarise(target, { compatible, free, chain, tested, quota }) {
  const lines = [`${target.label} connected successfully.`, `${compatible} compatible models found.`];
  if (FREE_STATUS_KNOWN.has(target.providerKey)) lines.push(`${free} free models currently available.`);
  else if (target.providerKey === 'gemini') lines.push(`${free} models on Google's free tier.`);
  else lines.push(`Free-tier status is not published per model for ${target.label}.`);
  lines.push(`Wenze selected ${chain.length} preferred model${chain.length === 1 ? '' : 's'} for fallback.`);
  if (tested) lines.push(`Test call answered by ${tested.model} in ${tested.latencyMs}ms.`);
  else if (quota) lines.push('The key is valid, but the allowance is spent right now; Wenze will retry after the reset.');
  else lines.push('The test call did not get through (the provider was busy); the key was accepted when listing models.');
  return lines.join('\n');
}

/**
 * @returns {Promise<{ok: true, providerKey, label, report, message} | {ok: false, reason, message}>}
 */
async function connectProvider({
  catalogKey, apiKey, label = null, baseUrl = null, adapter = null, providerKey = null,
  updatedBy = null, freeOnly = null,
} = {}, deps = defaultDeps()) {
  const key = String(apiKey || '').trim();
  if (!key) return failure('missing_key', 'Paste the provider\'s API key to connect.');
  const resolved = resolveTarget({ catalogKey, label, baseUrl, adapter, providerKey });
  if (resolved.error) return resolved.error;
  const { entry, target } = resolved;

  let models;
  try {
    models = await deps.listModels({
      adapter: target.adapter, baseUrl: target.baseUrl, apiKey: key, providerKey: target.providerKey,
    });
  } catch (err) {
    const verdict = classifyFailure({ status: err.status ?? null, message: err.message, code: err.code });
    if (verdict.kind === FAILURE.CREDENTIAL) return failure('invalid_key', `API key is invalid.${keyHint(entry, key)}`);
    if (err.status === 404) {
      return failure('no_models_endpoint', `${target.label} is reachable, but there is no models listing at ${target.baseUrl}/models. Check the Base URL.`);
    }
    return failure('unreachable', `Could not reach ${target.label}: ${err.message}`);
  }

  const chatCapable = models.filter(isChatCapable);
  const free = chatCapable.filter((m) => freeStatusOf(m, target.providerKey) === 'free').length;
  const useFreeOnly = freeOnly ?? (await deps.aiSettings.getAiSettings()).freeOnlyMode === true;
  let chain = selectModelChain(models, { providerKey: target.providerKey, freeOnly: useFreeOnly });
  if (!chain.length) {
    if (!chatCapable.length) {
      return failure('no_compatible_models', `${target.label} is reachable and the key works, but none of its ${models.length} models can answer a chat prompt.`);
    }
    return failure('no_free_models', `${target.label} is reachable, but no compatible free models are currently available. Turn off "Free tiers only" in AI settings, or choose another provider.`);
  }

  const smoke = await smokeTest(target, key, chain, deps);
  if (smoke.credential) return failure('invalid_key', `API key is invalid.${keyHint(entry, key)}`);
  // A model the provider REFUSED (unknown, decommissioned) leaves the chain; a
  // model that was merely busy stays, because busy says nothing about the model.
  const refusedIds = new Set(smoke.refused.filter((r) => !r.transient).map((r) => r.model));
  chain = chain.filter((m) => !refusedIds.has(m));
  if (!chain.length) {
    const names = smoke.refused.map((r) => r.model).join(', ');
    return failure('models_refused', `The key works, but ${target.label} refused every model Wenze tried (${names}).`);
  }

  const existing = await deps.aiProviders.getProviderSecretsByKey(target.providerKey);
  await deps.aiProviders.upsertProvider(target.providerKey, {
    label: target.label, adapter: target.adapter, enabled: true,
    ...(existing ? {} : { priority: await deps.aiProviders.nextPriority() }),
    isFree: target.isFree, baseUrl: target.baseUrl, modelChain: chain, apiKey: key,
    catalogKey: target.catalogKey, updatedBy,
  });
  await deps.aiProviders.saveDiscoveredModels(target.providerKey, {
    models: models.map((m) => ({
      id: m.id, contextLength: m.contextLength, chat: isChatCapable(m),
      free: freeStatusOf(m, target.providerKey),
    })),
  });
  await deps.modelEvents.recordModelEvent({
    providerKey: target.providerKey, event: 'selected', initiator: 'connect',
    detail: { chain, tested: smoke.tested, modelsFound: models.length },
  });
  for (const r of smoke.refused.filter((x) => !x.transient)) {
    await deps.modelEvents.recordModelEvent({
      providerKey: target.providerKey, model: r.model, event: 'refused', initiator: 'connect', detail: { error: r.error },
    });
  }
  for (const [kind, url] of Object.entries(entry.policySources || {})) {
    await deps.aiPolicy.addSource({ providerKey: target.providerKey, url, kind, sourceOrigin: 'catalog' });
  }
  deps.invalidateRegistry();

  const report = {
    modelsFound: models.length, compatible: chatCapable.length, free,
    freeStatusKnown: FREE_STATUS_KNOWN.has(target.providerKey) || target.providerKey === 'gemini',
    selected: chain, tested: smoke.tested, refused: smoke.refused, quota: smoke.quota,
    policySourcesSeeded: Object.keys(entry.policySources || {}).length,
  };
  return {
    ok: true, providerKey: target.providerKey, label: target.label, report,
    message: summarise(target, { compatible: chatCapable.length, free, chain, tested: smoke.tested, quota: smoke.quota }),
  };
}

module.exports = { connectProvider, resolveTarget, TEST_PROMPT, TEST_TIMEOUT_MS, FREE_STATUS_KNOWN };
