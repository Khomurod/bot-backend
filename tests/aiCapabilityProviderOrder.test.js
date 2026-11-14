'use strict';

/**
 * A task's OWN providers (owner, 14 November 2026; migration 0107;
 * lib/ai/providerChoice.js): the router asks only the providers chosen for
 * the task, in that order; an unsure answer goes to the next one on the list;
 * an empty list — or a task that needs a choice and has none — asks nobody;
 * a task with no list keeps the global order. Free-only mode, a switched-off
 * task and the vision allow-list still apply. The adapters are replaced.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const at = (rel) => path.resolve(__dirname, '..', rel);
const ROUTER = at('services/ai/router.js');
const REGISTRY = at('services/ai/registry.js');
const GATE = at('services/ai/capabilityGate.js');
const CHOICE = at('services/ai/capabilityProviders.js');
const ADAPTERS = {
  openai_chat: [at('services/ai/adapters/openaiChat.js'), 'callOpenAiChat'],
  gemini: [at('services/ai/adapters/gemini.js'), 'callGeminiGenerate'],
  anthropic: [at('services/ai/adapters/anthropic.js'), 'callAnthropicMessages'],
};
const STUBBED = [at('database/aiProviders.js'), at('database/aiCallLog.js'), at('database/aiSettings.js'), at('services/ai/learning/hooks.js')];

const {
  normaliseProviderOrder, effectiveProviderOrder, orderProviders,
} = require('../lib/ai/providerChoice');

const provider = (key, adapter, over = {}) => ({
  providerKey: key, adapter, enabled: true, isFree: true, priority: 10, baseUrl: 'https://example.invalid/v1',
  modelChain: [], apiKey: 'k', cooledUntil: null, consecutiveFailures: 0, ...over,
});
const GROQ = provider('groq', 'openai_chat', { modelChain: ['llama-4-scout', 'llama-3.1-8b'], priority: 10 });
const GEMINI = provider('gemini', 'gemini', { modelChain: ['gemini-2.5-flash'], priority: 20 });
const CLAUDE = provider('anthropic', 'anthropic', {
  isFree: false, priority: 30, modelChain: ['claude-opus-5-5'], discoveredModelIds: ['claude-sonnet-5-5', 'claude-haiku-5-5'],
});
const TEXT_ONLY = provider('cerebras', 'openai_chat', { modelChain: ['qwen-3-32b'], priority: 5 });

function loadRouter({ providers, rows = [], settings = {}, respond }) {
  for (const p of [ROUTER, REGISTRY, GATE, CHOICE]) delete require.cache[p];
  const logged = [];
  require.cache[STUBBED[3]] = { exports: { async lessonsFor() { return ''; }, onUncertain() {} } };
  require.cache[STUBBED[0]] = {
    exports: { async getProvidersForRouter() { return providers; }, async recordSuccess() {}, async recordFailure() {} },
  };
  require.cache[STUBBED[1]] = { exports: { async recordAiCall(e) { logged.push(e); } } };
  require.cache[STUBBED[2]] = {
    exports: {
      DEFAULTS: {},
      invalidateCache() {},
      async listCapabilities() { return rows; },
      async getAiSettings() {
        return {
          enabled: true, freeOnlyMode: false, routingMode: 'priority', requestTimeoutMs: 1000, maxRetryWaitMs: 5000, ...settings,
        };
      },
    },
  };
  const calls = [];
  for (const [adapter, [file, name]] of Object.entries(ADAPTERS)) {
    require.cache[file] = {
      exports: {
        DEFAULT_TIMEOUT_MS: 1000,
        [name]: async (args) => {
          calls.push(`${adapter}/${args.model}`);
          return { text: JSON.stringify(respond({ adapter, ...args })), model: args.model, usage: null };
        },
      },
    };
  }
  // eslint-disable-next-line global-require
  return { router: require(ROUTER), calls, logged };
}

test.after(() => {
  for (const p of [ROUTER, REGISTRY, GATE, CHOICE, ...STUBBED, ...Object.values(ADAPTERS).map(([f]) => f)]) delete require.cache[p];
});

const row = (key, order, over = {}) => ({ capabilityKey: key, aiEnabled: true, providerOrder: order, ...over });
const IMAGE = [{ text: 'Photo 1:' }, { inline_data: { mime_type: 'image/jpeg', data: 'AAAA' } }];
const cdlAsk = { capability: 'hiring_cdl_reading', systemText: 'Read it. "confidence": 0-100', userText: 'x', expects: 'json', extraParts: IMAGE };
const sure = { is_cdl: true, front_photo: 1, unclear: false, confidence: 95, fields: {} };
const unsure = { ...sure, confidence: 40 };

test('the pure rule: a list is cleaned; no list follows the global order unless the task needs a choice', () => {
  assert.deepEqual(normaliseProviderOrder([' gemini', 'anthropic', 'gemini'], ['gemini', 'anthropic']),
    { ok: true, order: ['gemini', 'anthropic'] });
  assert.match(normaliseProviderOrder(['openai'], ['gemini']).error, /no provider "openai"/);
  assert.match(normaliseProviderOrder('gemini').error, /must be a list/);
  assert.match(normaliseProviderOrder([42]).error, /not valid/);
  assert.equal(effectiveProviderOrder({ key: 'x' }, null), null);
  assert.deepEqual(effectiveProviderOrder({ providerChoice: 'required' }, null), []);
  assert.deepEqual(effectiveProviderOrder({ providerChoice: 'required' }, ['gemini']), ['gemini']);
  assert.deepEqual(orderProviders([GROQ, GEMINI, CLAUDE], ['anthropic', 'gemini']).map((p) => p.providerKey), ['anthropic', 'gemini']);
});

test('NO PROVIDER CHOSEN: the CDL is asked of nobody — not even the global order', async () => {
  for (const rows of [[], [row('hiring_cdl_reading', null)], [row('hiring_cdl_reading', [])]]) {
    const { router, calls, logged } = loadRouter({ providers: [GROQ, GEMINI, CLAUDE], rows, respond: () => sure });
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(router.runCapability(cdlAsk), (err) => err.aiUnavailable === true && /No provider is chosen/.test(err.message));
    assert.deepEqual(calls, []);
    assert.deepEqual(logged.map((e) => e.outcome), ['skipped']);
  }
});

test('ONLY CLAUDE: Claude alone is asked — Sonnet first, never Opus — and its answer stands', async () => {
  const { router, calls } = loadRouter({
    providers: [GROQ, GEMINI, CLAUDE], rows: [row('hiring_cdl_reading', ['anthropic'])], respond: () => sure,
  });
  const out = await router.runCapability(cdlAsk);
  assert.equal(out.provider, 'anthropic');
  assert.equal(out.uncertain, false);
  assert.deepEqual(calls, ['anthropic/claude-sonnet-5-5']);
});

test('GEMINI THEN CLAUDE: a sure Gemini stands; an unsure one goes to Claude — whatever the global order', async () => {
  let { router, calls } = loadRouter({
    providers: [CLAUDE, GROQ, GEMINI], rows: [row('hiring_cdl_reading', ['gemini', 'anthropic'])], respond: () => sure,
  });
  let out = await router.runCapability(cdlAsk);
  assert.deepEqual([out.provider, calls], ['gemini', ['gemini/gemini-2.5-flash']]);

  ({ router, calls } = loadRouter({
    providers: [CLAUDE, GROQ, GEMINI],
    rows: [row('hiring_cdl_reading', ['gemini', 'anthropic'])],
    respond: (a) => (a.adapter === 'gemini' ? unsure : sure),
  }));
  out = await router.runCapability(cdlAsk);
  assert.deepEqual([out.provider, out.uncertain], ['anthropic', false]);
  assert.deepEqual(calls, ['gemini/gemini-2.5-flash', 'anthropic/claude-sonnet-5-5']);
});

test('NOBODY SURE along the list: the last answer comes back marked uncertain', async () => {
  const { router, calls } = loadRouter({
    providers: [GROQ, GEMINI], rows: [row('hiring_cdl_reading', ['groq', 'gemini'])], respond: () => unsure,
  });
  const out = await router.runCapability(cdlAsk);
  assert.deepEqual([out.provider, out.uncertain], ['gemini', true]);
  assert.deepEqual(calls, ['openai_chat/llama-4-scout', 'gemini/gemini-2.5-flash'], 'a text-only model is never shown the photo');
});

test('a chosen provider that cannot see a picture is never asked about one', async () => {
  const { router, calls } = loadRouter({
    providers: [TEXT_ONLY, GEMINI], rows: [row('hiring_cdl_reading', ['cerebras', 'gemini'])], respond: () => sure,
  });
  const out = await router.runCapability(cdlAsk);
  assert.equal(out.provider, 'gemini');
  assert.deepEqual(calls, ['gemini/gemini-2.5-flash']);
});

test('free-only mode still refuses a paid provider, and a switched-off task is not asked at all', async () => {
  let { router, calls } = loadRouter({
    providers: [GEMINI, CLAUDE], settings: { freeOnlyMode: true }, rows: [row('hiring_cdl_reading', ['anthropic'])], respond: () => sure,
  });
  await assert.rejects(router.runCapability(cdlAsk), (err) => err.aiUnavailable === true);
  assert.deepEqual(calls, []);
  ({ router, calls } = loadRouter({
    providers: [GEMINI], rows: [row('hiring_cdl_reading', ['gemini'], { aiEnabled: false })], respond: () => sure,
  }));
  await assert.rejects(router.runCapability(cdlAsk), /switched off/);
  assert.deepEqual(calls, []);
});

test('a task WITHOUT its own list keeps the global order; one WITH a list keeps to it', async () => {
  const text = { capability: 'translation', systemText: 'Translate', userText: 'hola' };
  let { router, calls } = loadRouter({ providers: [GEMINI, GROQ], respond: () => ({ ok: true }) });
  await router.runCapability(text);
  assert.deepEqual(calls, ['openai_chat/llama-4-scout'], 'priority order: groq (10) before gemini (20)');
  ({ router, calls } = loadRouter({ providers: [GEMINI, GROQ], rows: [row('translation', ['gemini'])], respond: () => ({ ok: true }) }));
  const out = await router.runCapability(text);
  assert.deepEqual([out.provider, calls], ['gemini', ['gemini/gemini-2.5-flash']]);
});
