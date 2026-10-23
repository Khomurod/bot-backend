'use strict';

/**
 * The owner's rule (October 2026): "if I put Claude first, Claude is used
 * first, and the others I lined up are the fallbacks, in order" — and "I
 * choose the models myself".
 *
 * Pinned here, with the adapters replaced:
 *   - a Claude provider is asked through the Anthropic adapter, in its place in
 *     the order, with the models chosen for it;
 *   - when it cannot answer, the next provider in the order is asked;
 *   - "Free tiers only" still guarantees no paid call;
 *   - Wenze's model refresh never adds to a chain an operator chose, and never
 *     picks a premium Claude model on its own.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROUTER = path.resolve(__dirname, '../services/ai/router.js');
const REGISTRY = path.resolve(__dirname, '../services/ai/registry.js');
const GATE = path.resolve(__dirname, '../services/ai/capabilityGate.js');
const OPENAI = path.resolve(__dirname, '../services/ai/adapters/openaiChat.js');
const GEMINI = path.resolve(__dirname, '../services/ai/adapters/gemini.js');
const ANTHROPIC = path.resolve(__dirname, '../services/ai/adapters/anthropic.js');
const PROVIDERS = path.resolve(__dirname, '../database/aiProviders.js');
const CALL_LOG = path.resolve(__dirname, '../database/aiCallLog.js');
const SETTINGS = path.resolve(__dirname, '../database/aiSettings.js');

const { reconcileChain, selectModelChain, normaliseModel } = require('../lib/ai/modelSelection');
const { refreshProviderModels } = require('../services/ai/discovery/refreshModels');

const claude = (over = {}) => ({
  providerKey: 'anthropic', adapter: 'anthropic', enabled: true, isFree: false, priority: 10,
  baseUrl: 'https://api.anthropic.com', modelChain: ['claude-haiku-5-5', 'claude-sonnet-5-5'],
  apiKey: 'sk-ant-k', cooledUntil: null, consecutiveFailures: 0, ...over,
});
const groq = (over = {}) => ({
  providerKey: 'groq', adapter: 'openai_chat', enabled: true, isFree: true, priority: 20,
  baseUrl: 'https://example.invalid/v1', modelChain: ['llama'], apiKey: 'k',
  cooledUntil: null, consecutiveFailures: 0, ...over,
});

function loadRouter({ providers, settings = {}, respond }) {
  for (const p of [ROUTER, REGISTRY, GATE]) delete require.cache[require.resolve(p)];
  require.cache[PROVIDERS] = {
    exports: {
      async getProvidersForRouter() { return providers; },
      async recordSuccess() {},
      async recordFailure() {},
    },
  };
  require.cache[CALL_LOG] = { exports: { async recordAiCall() {} } };
  require.cache[SETTINGS] = {
    exports: {
      DEFAULTS: {},
      invalidateCache() {},
      async listCapabilities() { return []; },
      async getAiSettings() {
        return {
          enabled: true, freeOnlyMode: false, routingMode: 'priority',
          requestTimeoutMs: 1000, maxRetryWaitMs: 5000, ...settings,
        };
      },
    },
  };
  const calls = [];
  const adapterFor = (adapter) => async (args) => {
    calls.push({ adapter, ...args });
    return respond({ adapter, ...args });
  };
  require.cache[OPENAI] = { exports: { callOpenAiChat: adapterFor('openai_chat'), DEFAULT_TIMEOUT_MS: 1000 } };
  require.cache[GEMINI] = { exports: { callGeminiGenerate: adapterFor('gemini'), DEFAULT_TIMEOUT_MS: 1000 } };
  require.cache[ANTHROPIC] = { exports: { callAnthropicMessages: adapterFor('anthropic'), DEFAULT_TIMEOUT_MS: 1000 } };
  // eslint-disable-next-line global-require
  return { router: require(ROUTER), calls };
}

test.after(() => {
  for (const p of [ROUTER, REGISTRY, GATE, OPENAI, GEMINI, ANTHROPIC, PROVIDERS, CALL_LOG, SETTINGS]) {
    delete require.cache[p];
  }
});

const ok = ({ model }) => ({ text: 'answered', model, payload: {}, usage: null });

test('CLAUDE FIRST IS ASKED FIRST, through its own adapter, with the models chosen for it', async () => {
  const { router, calls } = loadRouter({ providers: [groq(), claude()], respond: ok });
  const out = await router.runCapability({ capability: 'x', systemText: 'S', userText: 'hi' });
  assert.equal(out.provider, 'anthropic');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].adapter, 'anthropic');
  assert.equal(calls[0].model, 'claude-haiku-5-5');
  assert.deepEqual(calls[0].messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }]);
});

test('when Claude cannot answer, its next model and then the next provider are asked, in order', async () => {
  const busy = Object.assign(new Error('529 Overloaded'), { status: 529 });
  const { router, calls } = loadRouter({
    providers: [claude(), groq()],
    respond: (args) => { if (args.adapter === 'anthropic') throw busy; return ok(args); },
  });
  const out = await router.runCapability({ capability: 'x', userText: 'hi' });
  assert.equal(out.provider, 'groq');
  assert.deepEqual(calls.map((c) => c.model), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'llama']);
});

test('moving Groq above Claude makes Groq the primary', async () => {
  const { router, calls } = loadRouter({
    providers: [claude({ priority: 20 }), groq({ priority: 10 })], respond: ok,
  });
  assert.equal((await router.runCapability({ capability: 'x', userText: 'hi' })).provider, 'groq');
  assert.equal(calls.length, 1);
});

test('"Free tiers only" still guarantees Claude is never called', async () => {
  const { router, calls } = loadRouter({
    providers: [claude(), groq()], settings: { freeOnlyMode: true }, respond: ok,
  });
  assert.equal((await router.runCapability({ capability: 'x', userText: 'hi' })).provider, 'groq');
  assert.ok(calls.every((c) => c.adapter !== 'anthropic'));
});

test('a picture goes to Claude WITH the picture, as an image part (23 October 2026)', async () => {
  const { router, calls } = loadRouter({ providers: [claude()], respond: ok });
  await router.runCapability({
    capability: 'x', userText: 'read this', extraParts: [{ inline_data: { mime_type: 'image/png', data: 'AA==' } }],
  });
  assert.equal(calls.length, 1);
  const user = calls[0].messages.find((m) => m.role === 'user');
  assert.deepEqual(user.content, [
    { type: 'text', text: 'read this' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
  ]);
});

test('a picture is never offered to a model that cannot see it', async () => {
  const { router, calls } = loadRouter({ providers: [groq({ modelChain: ['llama-3.3-70b-versatile'] })], respond: ok });
  await assert.rejects(router.runCapability({
    capability: 'x', userText: 'read this', extraParts: [{ inline_data: { data: 'AA==' } }],
  }), (err) => err.aiUnavailable === true);
  assert.equal(calls.length, 0);
});

test('a free model that can see is asked about a picture, with only its vision models', async () => {
  const { router, calls } = loadRouter({
    providers: [groq({ modelChain: ['llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct'] })],
    respond: ok,
  });
  await router.runCapability({ capability: 'x', userText: 'read', extraParts: [{ inline_data: { data: 'AA==' } }] });
  assert.deepEqual(calls.map((c) => c.model), ['meta-llama/llama-4-scout-17b-16e-instruct']);
});

// ── the models are the operator's ──────────────────────────────────────────

const listing = (ids, providerKey = 'anthropic') => ids.map((id) => normaliseModel({ id }, 'anthropic', providerKey));

test('A CHAIN AN OPERATOR CHOSE IS LEFT ALONE when nothing was retired', () => {
  const r = reconcileChain(['claude-haiku-5-5'],
    listing(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-4-5']),
    { providerKey: 'anthropic' });
  assert.deepEqual(r.chain, ['claude-haiku-5-5']);
  assert.deepEqual(r.added, []);
});

test('a free provider\'s retired model is replaced one for one; a paid one\'s is only removed', () => {
  const ids = ['llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant']
    .map((id) => normaliseModel({ id }, 'openai_chat', 'groq'));
  const free = reconcileChain(['llama-3.3-70b-versatile', 'gone'], ids, { providerKey: 'groq' });
  assert.equal(free.added.length, 1);
  assert.equal(free.chain.length, 2);

  const paid = reconcileChain(['claude-sonnet-4-5', 'claude-haiku-5-5'],
    listing(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']),
    { providerKey: 'anthropic', replaceRetired: false });
  assert.deepEqual(paid.retired, ['claude-sonnet-4-5']);
  assert.deepEqual(paid.chain, ['claude-haiku-5-5']);
  assert.deepEqual(paid.added, []);
});

test('Wenze never picks Opus, Fable or Mythos on its own — only a person can', () => {
  const chain = selectModelChain(
    listing(['claude-opus-5-5', 'claude-fable-5-1', 'claude-mythos-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5']),
    { providerKey: 'anthropic' }
  );
  assert.deepEqual(chain, ['claude-haiku-5-5', 'claude-sonnet-5-5'], 'cheapest suitable first');
});

test('the daily refresh tells reconcile a paid provider is not to be topped up', async () => {
  const writes = [];
  const result = await refreshProviderModels('anthropic', {}, {
    listModels: async () => listing(['claude-haiku-5-5', 'claude-sonnet-5-5']),
    aiProviders: {
      async getProviderSecretsByKey() {
        return { ...claude({ modelChain: ['claude-sonnet-4-5'] }), catalogKey: 'anthropic' };
      },
      async saveDiscoveredModels() {},
      async upsertProvider(key, patch) { writes.push(patch); },
    },
    aiSettings: { async getAiSettings() { return { freeOnlyMode: false }; } },
    modelEvents: { async recordModelEvent() {} },
    invalidateRegistry() {},
  });
  assert.deepEqual(result.retired, ['claude-sonnet-4-5']);
  assert.deepEqual(result.added, [], 'no model nobody chose starts costing money');
  assert.deepEqual(writes[0].modelChain, []);
});
