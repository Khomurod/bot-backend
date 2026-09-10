/**
 * A provider's life in Wenze — onboarding, a retired model, a dead key, an
 * outage — end to end through the real modules, with the network and the data
 * layer replaced. No database.
 *
 * The brief's four AI scenarios, in the order they happen to a fleet:
 *
 *   An operator pastes a key. Everything else is discovered.
 *   The provider retires a model. Wenze notices, switches, and says so.
 *   A key dies. That provider stops; the next one answers.
 *   Every provider is down. Every consumer is told, in the shape it already reads.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { connectProvider } = require('../services/ai/discovery/connectProvider');
const { refreshProviderModels } = require('../services/ai/discovery/refreshModels');
const { runModelMaintenance } = require('../services/ai/discovery/modelMaintenance');
const { normaliseModel } = require('../lib/ai/modelSelection');

const openai = (id, providerKey) => ({ ...normaliseModel({ id }, 'openai_chat'), providerKey });
const httpError = (status, message) => { const e = new Error(message); e.status = status; return e; };

/** A tiny in-memory ai_providers + ai_model_events, shared by every step. */
function world() {
  const providers = new Map();
  const events = [];
  const listings = new Map();
  let priority = 10;
  const deps = {
    listModels: async ({ providerKey }) => {
      const l = listings.get(providerKey);
      if (l instanceof Error) throw l;
      return l || [];
    },
    callOpenAiChat: async () => ({ text: 'ok' }),
    callGeminiGenerate: async () => ({ text: 'ok' }),
    aiProviders: {
      async getProviderSecretsByKey(key) { return providers.get(key) || null; },
      async nextPriority() { priority += 10; return priority; },
      async upsertProvider(key, patch) {
        providers.set(key, { ...(providers.get(key) || {}), providerKey: key, ...patch });
        return providers.get(key);
      },
      async saveDiscoveredModels(key, payload) {
        providers.set(key, { ...(providers.get(key) || {}), discoveredModels: payload.models || [], modelsRefreshError: payload.error || null });
      },
      async listProvidersForAdmin() {
        return [...providers.values()].map((p) => ({ ...p, label: p.label || p.providerKey, apiKeySet: Boolean(p.apiKey) }));
      },
    },
    aiSettings: { async getAiSettings() { return { freeOnlyMode: false }; } },
    aiPolicy: {
      async addSource(s) { return s; },
      async getWatcherSettings() { return { enabled: true, notifyEnabled: true, notifyChatId: '-1001', notifyMinSeverity: 'info' }; },
    },
    modelEvents: {
      async recordModelEvent(e) { const row = { id: events.length + 1, notifiedAt: null, ...e }; events.push(row); return row; },
      async listUnnotifiedRetirements(providerKey) {
        return events.filter((e) => e.providerKey === providerKey && e.event === 'retired' && !e.notifiedAt);
      },
      async markEventsNotified(ids) { for (const e of events) if (ids.includes(e.id)) e.notifiedAt = new Date(); },
    },
    findingsStore: {
      findings: [], alerts: [],
      async insertFinding(f) { deps.findingsStore.findings.push(f); return { id: deps.findingsStore.findings.length, ...f }; },
      async enqueueAlert(a) { deps.findingsStore.alerts.push(a); return a; },
      meetsSeverityThreshold: () => true,
    },
    invalidateRegistry() {},
    refreshProviderModels: (key, opts) => refreshProviderModels(key, opts, deps),
  };
  return { deps, providers, events, listings };
}

test('onboarding → retirement → dead key → outage, through the real modules', async () => {
  const w = world();

  // ── 1. Two keys pasted; everything else discovered ─────────────────────────
  w.listings.set('groq', ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'whisper-large-v3'].map((m) => openai(m, 'groq')));
  w.listings.set('cerebras', ['llama3.1-8b', 'llama-3.3-70b'].map((m) => openai(m, 'cerebras')));
  const groq = await connectProvider({ catalogKey: 'groq', apiKey: 'gsk_scenario', updatedBy: 'admin' }, w.deps);
  const cerebras = await connectProvider({ catalogKey: 'cerebras', apiKey: 'csk-scenario', updatedBy: 'admin' }, w.deps);
  assert.equal(groq.ok, true, groq.message);
  assert.equal(cerebras.ok, true, cerebras.message);
  assert.match(groq.message, /Groq connected successfully\./);
  assert.match(groq.message, /3 compatible models found\./, 'whisper is not a chat model');
  assert.equal(w.providers.get('groq').baseUrl, 'https://api.groq.com/openai/v1', 'nobody typed a URL');
  assert.ok(w.providers.get('groq').modelChain.includes('mixtral-8x7b-32768'));
  assert.ok(w.providers.get('cerebras').priority > w.providers.get('groq').priority, 'a new provider goes after the existing ones');

  // ── 2. Groq retires mixtral overnight; the daily maintenance notices ───────
  w.listings.set('groq', ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-20b'].map((m) => openai(m, 'groq')));
  const summary = await runModelMaintenance({}, w.deps);
  assert.equal(summary.retired, 1);
  assert.equal(w.providers.get('groq').modelChain.includes('mixtral-8x7b-32768'), false, 'retired from the chain');
  assert.ok(w.providers.get('groq').modelChain.includes('openai/gpt-oss-20b'), 'the new model fills the chain');
  const [finding] = w.deps.findingsStore.findings;
  assert.match(finding.summary, /Groq retired one of Wenze's models \(mixtral-8x7b-32768\)\./);
  assert.match(finding.summary, /No Wenze features were interrupted\./);
  assert.equal(w.deps.findingsStore.alerts.length, 1, 'a person is told, once');
  assert.equal(w.events.filter((e) => e.event === 'retired' && e.notifiedAt).length, 1, 'and the event is stamped told');

  // The next morning nothing changed: nobody is told again.
  await runModelMaintenance({}, w.deps);
  assert.equal(w.deps.findingsStore.alerts.length, 1);
});

// ─── the router, on the state the steps above left behind ────────────────────

const ROUTER = path.resolve(__dirname, '../services/ai/router.js');
const REGISTRY = path.resolve(__dirname, '../services/ai/registry.js');

function loadRouter({ providers, respond }) {
  for (const p of [ROUTER, REGISTRY]) delete require.cache[require.resolve(p)];
  const recorded = { cooled: [], success: [] };
  require.cache[path.resolve(__dirname, '../database/aiProviders.js')] = {
    exports: {
      async getProvidersForRouter() { return providers; },
      async recordSuccess(key) { recorded.success.push(key); },
      async recordFailure(key, args) { recorded.cooled.push({ key, ...args }); },
    },
  };
  require.cache[path.resolve(__dirname, '../database/aiCallLog.js')] = { exports: { async recordAiCall() {} } };
  require.cache[path.resolve(__dirname, '../database/aiSettings.js')] = {
    exports: {
      DEFAULTS: {}, invalidateCache() {},
      async getAiSettings() { return { enabled: true, freeOnlyMode: false, routingMode: 'priority', requestTimeoutMs: 1000, maxRetryWaitMs: 100 }; },
    },
  };
  const calls = [];
  const adapter = async (args) => { calls.push(args); return respond(args); };
  require.cache[path.resolve(__dirname, '../services/ai/adapters/openaiChat.js')] = { exports: { callOpenAiChat: adapter, DEFAULT_TIMEOUT_MS: 1000 } };
  require.cache[path.resolve(__dirname, '../services/ai/adapters/gemini.js')] = { exports: { callGeminiGenerate: adapter, DEFAULT_TIMEOUT_MS: 1000 } };
  const router = require(ROUTER);
  return { router, calls, recorded };
}

const routerProvider = (over) => ({
  adapter: 'openai_chat', enabled: true, isFree: true, baseUrl: 'https://example.invalid/v1', apiKey: 'k',
  cooledUntil: null, consecutiveFailures: 0, discoveredModelIds: [], ...over,
});

test('a dead key on Groq stops Groq and nothing else; Cerebras answers the same request', async () => {
  const { router, calls, recorded } = loadRouter({
    providers: [
      routerProvider({ providerKey: 'groq', priority: 10, modelChain: ['llama-3.3-70b-versatile', 'openai/gpt-oss-20b'] }),
      routerProvider({ providerKey: 'cerebras', priority: 20, modelChain: ['llama-3.3-70b'] }),
    ],
    respond: ({ model }) => {
      if (model.startsWith('llama-3.3-70b-v') || model.startsWith('openai/')) throw httpError(401, 'Invalid API Key');
      return { text: 'answered by cerebras', model, payload: {}, usage: null };
    },
  });
  const result = await router.runCapability({ capability: 'home_time_intent', userText: 'uyda' });
  assert.equal(result.provider, 'cerebras');
  assert.deepEqual(calls.map((c) => c.model), ['llama-3.3-70b-versatile', 'llama-3.3-70b'],
    'one refusal per provider: a dead key covers every model, so its second model is not asked');
  assert.deepEqual(recorded.cooled.map((c) => c.key), ['groq'], 'only the provider with the dead key is cooled');
  assert.deepEqual(recorded.success, ['cerebras']);
});

test('every provider down is an outage the consumers already know how to read — and never an exception into a feature', async () => {
  const { router } = loadRouter({
    providers: [
      routerProvider({ providerKey: 'groq', priority: 10, modelChain: ['a'] }),
      routerProvider({ providerKey: 'cerebras', priority: 20, modelChain: ['b'] }),
    ],
    respond: () => { throw httpError(503, 'Service Unavailable'); },
  });
  await assert.rejects(
    () => router.runCapability({ capability: 'home_time_intent', userText: 'hi' }),
    (err) => {
      assert.equal(err.aiUnavailable, true);
      assert.equal(err.attemptErrors.length, 2, 'both providers were tried');
      assert.equal(err.allRateLimited, true, 'the shape aiAnnotationService and dispatchParser already read');
      return true;
    }
  );
  // The deterministic fallback every consumer keeps beneath the router is the
  // subject of tests/aiOffDegradation.test.js; here the contract is that the
  // router never surfaces a raw provider error to a feature.
});
