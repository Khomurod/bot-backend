/**
 * The per-responsibility switch, enforced where every consumer already handles
 * it: the router.
 *
 * `ai_capabilities.ai_enabled` was written by the admin and read by nobody, so
 * switching "Driver Active/Inactive classification" off changed nothing at all.
 * A switch that does not switch anything is worse than no switch, because it is
 * believed. Gating in one place rather than at sixteen call sites means a
 * refused capability raises the same error as a provider outage — which is the
 * path each consumer already falls back through.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROUTER = path.resolve(__dirname, '../services/ai/router.js');
const REGISTRY = path.resolve(__dirname, '../services/ai/registry.js');
const OPENAI = path.resolve(__dirname, '../services/ai/adapters/openaiChat.js');
const GEMINI = path.resolve(__dirname, '../services/ai/adapters/gemini.js');
const PROVIDERS = path.resolve(__dirname, '../database/aiProviders.js');
const CALL_LOG = path.resolve(__dirname, '../database/aiCallLog.js');
const GATE = path.resolve(__dirname, '../services/ai/capabilityGate.js');

const provider = (over = {}) => ({
  providerKey: 'groq', adapter: 'openai_chat', enabled: true, isFree: true, priority: 1,
  baseUrl: 'https://example.invalid/v1', modelChain: ['model-a'], apiKey: 'k',
  cooledUntil: null, consecutiveFailures: 0, ...over,
});

function loadRouter({ respond, capabilities = [] }) {
  for (const p of [ROUTER, REGISTRY, GATE]) delete require.cache[require.resolve(p)];
  const recorded = { log: [] };
  require.cache[PROVIDERS] = {
    exports: {
      async getProvidersForRouter() { return [provider()]; },
      async recordSuccess() {}, async recordFailure() {},
    },
  };
  require.cache[CALL_LOG] = { exports: { async recordAiCall(entry) { recorded.log.push(entry); } } };
  require.cache[path.resolve(__dirname, '../database/aiSettings.js')] = {
    exports: {
      DEFAULTS: {},
      invalidateCache() {},
      async listCapabilities() { return capabilities; },
      async getAiSettings() {
        return {
          enabled: true, freeOnlyMode: false, routingMode: 'priority',
          requestTimeoutMs: 1000, maxRetryWaitMs: 5000,
        };
      },
    },
  };
  const calls = [];
  const adapter = async (args) => { calls.push(args); return respond(args); };
  require.cache[OPENAI] = { exports: { callOpenAiChat: adapter, DEFAULT_TIMEOUT_MS: 1000 } };
  require.cache[GEMINI] = { exports: { callGeminiGenerate: adapter, DEFAULT_TIMEOUT_MS: 1000 } };
  return { router: require(ROUTER), calls, recorded };
}

test('a capability switched off is refused before any provider is asked', async () => {
  const { router, calls, recorded } = loadRouter({
    respond: async () => ({ text: 'should never happen' }),
    capabilities: [{ capabilityKey: 'driver_status_classification', aiEnabled: false }],
  });
  await assert.rejects(
    () => router.runCapability({ capability: 'driver_status_classification', userText: 'x' }),
    /switched off for "driver_status_classification"/
  );
  assert.equal(calls.length, 0, 'no provider was called');
  const skipped = recorded.log.find((l) => l.outcome === 'skipped');
  assert.equal(skipped.capabilityKey, 'driver_status_classification',
    'and the refusal is recorded under the capability, not as unnamed activity');
});

test('switching one off leaves the others working', async () => {
  const { router, calls } = loadRouter({
    respond: async () => ({ text: 'ok' }),
    capabilities: [{ capabilityKey: 'driver_status_classification', aiEnabled: false }],
  });
  const out = await router.runCapability({ capability: 'home_time_intent', userText: 'x' });
  assert.equal(out.text, 'ok');
  assert.equal(calls.length, 1);
});

test('an untagged call is not gated — the switch governs named responsibilities', async () => {
  const { router, calls } = loadRouter({
    respond: async () => ({ text: 'ok' }),
    capabilities: [{ capabilityKey: 'anything', aiEnabled: false }],
  });
  await router.runCapability({ userText: 'x' });
  assert.equal(calls.length, 1);
});
