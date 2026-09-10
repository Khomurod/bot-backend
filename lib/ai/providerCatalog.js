/**
 * The known AI providers — everything Wenze can work out for an operator so they
 * do not have to. PURE: data and lookups, no I/O.
 *
 * WHY THIS EXISTS. "Add a provider" used to ask for a key, a protocol, a Base
 * URL and a comma-separated list of model identifiers. Every one of those is
 * public knowledge about the provider, not about this deployment, and asking an
 * administrator to look them up is asking them to do research a program can do.
 * With this table the normal flow is: pick the provider, paste the key, Connect.
 *
 * WHAT IS IN HERE IS PUBLIC AND STABLE-ISH. Endpoints and the models-listing
 * path change rarely; the policy URLs change more often, which is exactly why the
 * terms watcher follows redirects and rediscovers a page that disappears rather
 * than trusting this file forever. This table is the STARTING point for that
 * discovery, never the final word.
 *
 * `modelsPath` is how Wenze discovers models INSTEAD of hardcoding a list that
 * goes stale. Every provider here exposes a models endpoint; the shape differs
 * (OpenAI-compatible `/models` vs Gemini's `/models` with `supportedGenerationMethods`)
 * and `services/ai/discovery/modelDiscovery.js` handles that per adapter.
 *
 * `envKey` keeps today's deployment working: a provider with no stored key
 * inherits the named environment variable, the rule every other secret here
 * already follows.
 *
 * `custom` is the one entry that asks for a Base URL, because it is the one
 * provider Wenze cannot know anything about.
 */

const CATALOG = Object.freeze({
  groq: {
    key: 'groq',
    label: 'Groq',
    adapter: 'openai_chat',
    baseUrl: 'https://api.groq.com/openai/v1',
    modelsPath: '/models',
    envKey: 'GROQ_API_KEY',
    keyPrefix: 'gsk_',
    isFree: true,
    freeTierNote: 'Free tier on every model, with per-minute and per-day limits.',
    docsUrl: 'https://console.groq.com/docs',
    policySources: {
      terms: 'https://groq.com/terms-of-use/',
      privacy: 'https://groq.com/privacy-policy/',
      model_policy: 'https://console.groq.com/docs/deprecations',
      pricing: 'https://groq.com/pricing/',
    },
  },
  gemini: {
    key: 'gemini',
    label: 'Google Gemini',
    adapter: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    modelsPath: '/models',
    envKey: 'GEMINI_API_KEY',
    keyPrefix: 'AIza',
    isFree: true,
    freeTierNote: 'Free tier on the Flash models; per-model limits are not published per key.',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    policySources: {
      terms: 'https://ai.google.dev/gemini-api/terms',
      privacy: 'https://policies.google.com/privacy',
      model_policy: 'https://ai.google.dev/gemini-api/docs/deprecations',
      pricing: 'https://ai.google.dev/gemini-api/docs/pricing',
    },
  },
  openrouter: {
    key: 'openrouter',
    label: 'OpenRouter',
    adapter: 'openai_chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelsPath: '/models',
    envKey: 'OPENROUTER_API_KEY',
    keyPrefix: 'sk-or-',
    isFree: true,
    freeTierNote: 'Some models are free (marked `:free`); pricing is published per model.',
    docsUrl: 'https://openrouter.ai/docs',
    policySources: {
      terms: 'https://openrouter.ai/terms',
      privacy: 'https://openrouter.ai/privacy',
      model_policy: 'https://openrouter.ai/docs/models',
      pricing: 'https://openrouter.ai/models',
    },
  },
  cerebras: {
    key: 'cerebras',
    label: 'Cerebras',
    adapter: 'openai_chat',
    baseUrl: 'https://api.cerebras.ai/v1',
    modelsPath: '/models',
    envKey: 'CEREBRAS_API_KEY',
    keyPrefix: 'csk-',
    isFree: true,
    freeTierNote: 'Free tier with daily token limits.',
    docsUrl: 'https://inference-docs.cerebras.ai',
    policySources: {
      terms: 'https://www.cerebras.ai/terms-of-service',
      privacy: 'https://www.cerebras.ai/privacy-policy',
      model_policy: 'https://inference-docs.cerebras.ai/support/deprecations',
      pricing: 'https://www.cerebras.ai/pricing',
    },
  },
  mistral: {
    key: 'mistral',
    label: 'Mistral',
    adapter: 'openai_chat',
    baseUrl: 'https://api.mistral.ai/v1',
    modelsPath: '/models',
    envKey: 'MISTRAL_API_KEY',
    keyPrefix: null,
    isFree: true,
    freeTierNote: 'A free "experiment" tier exists; it allows Mistral to use submitted data.',
    docsUrl: 'https://docs.mistral.ai',
    policySources: {
      terms: 'https://mistral.ai/terms',
      privacy: 'https://mistral.ai/terms#privacy-policy',
      model_policy: 'https://docs.mistral.ai/getting-started/models/models_overview/',
      pricing: 'https://mistral.ai/pricing',
    },
  },
  together: {
    key: 'together',
    label: 'Together AI',
    adapter: 'openai_chat',
    baseUrl: 'https://api.together.xyz/v1',
    modelsPath: '/models',
    envKey: 'TOGETHER_API_KEY',
    keyPrefix: null,
    isFree: false,
    freeTierNote: 'Paid per token; a small sign-up credit only.',
    docsUrl: 'https://docs.together.ai',
    policySources: {
      terms: 'https://www.together.ai/terms-of-service',
      privacy: 'https://www.together.ai/privacy',
      model_policy: 'https://docs.together.ai/docs/deprecations',
      pricing: 'https://www.together.ai/pricing',
    },
  },
  deepseek: {
    key: 'deepseek',
    label: 'DeepSeek',
    adapter: 'openai_chat',
    baseUrl: 'https://api.deepseek.com/v1',
    modelsPath: '/models',
    envKey: 'DEEPSEEK_API_KEY',
    keyPrefix: 'sk-',
    isFree: false,
    freeTierNote: 'Paid per token.',
    docsUrl: 'https://api-docs.deepseek.com',
    policySources: {
      terms: 'https://platform.deepseek.com/downloads/DeepSeek%20Open%20Platform%20Terms%20of%20Service.html',
      privacy: 'https://platform.deepseek.com/downloads/DeepSeek%20Privacy%20Policy.html',
      model_policy: 'https://api-docs.deepseek.com/updates',
      pricing: 'https://api-docs.deepseek.com/quick_start/pricing',
    },
  },
  nvidia: {
    key: 'nvidia',
    label: 'NVIDIA NIM',
    adapter: 'openai_chat',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    modelsPath: '/models',
    envKey: 'NVIDIA_API_KEY',
    keyPrefix: 'nvapi-',
    isFree: true,
    freeTierNote: 'Developer tier with a request allowance; not for production volume.',
    docsUrl: 'https://docs.api.nvidia.com/nim/',
    policySources: {
      terms: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-api-trial-service/',
      privacy: 'https://www.nvidia.com/en-us/about-nvidia/privacy-policy/',
      model_policy: 'https://docs.api.nvidia.com/nim/reference/models-1',
      pricing: 'https://build.nvidia.com/pricing',
    },
  },
});

/**
 * The one entry that needs a Base URL, because Wenze cannot know it. Everything
 * else about it is still discovered: models from `/models`, the key proven by a
 * call, and the terms watcher left to the operator's optional URLs.
 */
const CUSTOM = Object.freeze({
  key: 'custom',
  label: 'Custom OpenAI-compatible provider',
  adapter: 'openai_chat',
  baseUrl: null,
  modelsPath: '/models',
  envKey: null,
  keyPrefix: null,
  isFree: false,
  freeTierNote: null,
  docsUrl: null,
  policySources: {},
});

function listCatalog() {
  return [...Object.values(CATALOG), CUSTOM];
}

function getCatalogEntry(key) {
  const k = String(key || '').trim().toLowerCase();
  if (k === 'custom') return CUSTOM;
  return CATALOG[k] || null;
}

/** The env var a provider inherits its key from, or null. Catalog-driven. */
function envKeyNameFor(providerKey) {
  return CATALOG[String(providerKey || '').toLowerCase()]?.envKey || null;
}

/**
 * Does the pasted key even look like this provider's? A wrong-provider paste is
 * the most common connect mistake and a 401 does not say which one it was.
 * Advisory only: a provider that changes its prefix must not lock people out.
 */
function keyLooksLike(entry, apiKey) {
  if (!entry?.keyPrefix) return true;
  return String(apiKey || '').startsWith(entry.keyPrefix);
}

module.exports = {
  CATALOG, CUSTOM, listCatalog, getCatalogEntry, envKeyNameFor, keyLooksLike,
};
