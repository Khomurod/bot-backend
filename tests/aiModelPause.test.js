'use strict';

/**
 * A spent allowance on ONE model pauses that model, not its provider.
 *
 * Groq and Gemini count free allowances per model. Cooling the whole provider
 * when `openai/gpt-oss-20b` spent its tokens-per-day left the four other models
 * of the chain — each with an untouched allowance — unasked until the next UTC
 * day. The owner (October 2026): when one model's quota runs out, switch
 * automatically.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROUTER = path.resolve(__dirname, '../services/ai/router.js');
const REGISTRY = path.resolve(__dirname, '../services/ai/registry.js');
const GATE = path.resolve(__dirname, '../services/ai/capabilityGate.js');
const OPENAI = path.resolve(__dirname, '../services/ai/adapters/openaiChat.js');
const GEMINI = path.resolve(__dirname, '../services/ai/adapters/gemini.js');
const PROVIDERS = path.resolve(__dirname, '../database/aiProviders.js');
const CALL_LOG = path.resolve(__dirname, '../database/aiCallLog.js');
const SETTINGS = path.resolve(__dirname, '../database/aiSettings.js');

const { FAILURE, classifyFailure } = require('../lib/ai/classify');
const { modelPause } = require('../lib/ai/cooldown');

const TPD = '429 Rate limit reached for model `openai/gpt-oss-20b` in organization `o` service tier `on_demand` '
  + 'on tokens per day (TPD): Limit 200000, Used 198251, Requested 3497. Please try again in 12m35.136s. '
  + 'Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing';

const groq = (over = {}) => ({
  providerKey: 'groq', adapter: 'openai_chat', enabled: true, isFree: true, priority: 10,
  baseUrl: 'https://example.invalid/v1', modelChain: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'],
  apiKey: 'k', cooledUntil: null, consecutiveFailures: 0, modelCooldowns: {}, ...over,
});

function loadRouter({ providers, respond }) {
  for (const p of [ROUTER, REGISTRY, GATE]) delete require.cache[require.resolve(p)];
  const recorded = { paused: [], cooled: [], cleared: [] };
  require.cache[PROVIDERS] = {
    exports: {
      async getProvidersForRouter() { return providers; },
      async recordSuccess() {},
      async recordFailure(key, args) { recorded.cooled.push({ key, ...args }); },
      async pauseModel(key, model, args) { recorded.paused.push({ key, model, ...args }); },
      async clearModelPause(key, model) { recorded.cleared.push({ key, model }); },
    },
  };
  require.cache[CALL_LOG] = { exports: { async recordAiCall() {} } };
  require.cache[SETTINGS] = {
    exports: {
      DEFAULTS: {},
      invalidateCache() {},
      async listCapabilities() { return []; },
      async getAiSettings() {
        return { enabled: true, freeOnlyMode: false, routingMode: 'priority', requestTimeoutMs: 1000, maxRetryWaitMs: 35000 };
      },
    },
  };
  const calls = [];
  const adapter = async (args) => { calls.push(args.model); return respond(args); };
  require.cache[OPENAI] = { exports: { callOpenAiChat: adapter, DEFAULT_TIMEOUT_MS: 1000 } };
  require.cache[GEMINI] = { exports: { callGeminiGenerate: adapter, DEFAULT_TIMEOUT_MS: 1000 } };
  // eslint-disable-next-line global-require
  return { router: require(ROUTER), calls, recorded };
}

test.after(() => {
  for (const p of [ROUTER, REGISTRY, GATE, OPENAI, GEMINI, PROVIDERS, CALL_LOG, SETTINGS]) delete require.cache[p];
});

test('a quota that names one model is that model\'s, and does not cool the provider', () => {
  const verdict = classifyFailure({ status: 429, message: TPD });
  assert.equal(verdict.kind, FAILURE.QUOTA);
  assert.equal(verdict.scope, 'model');
  assert.equal(verdict.coolProvider, false);
  for (const wide of [
    '429 Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day',
    '402 Your prepayment credits are depleted. Please go to AI Studio to manage billing.',
  ]) {
    assert.equal(classifyFailure({ status: 429, message: wide }).scope, 'provider', wide);
  }
});

test('WHEN ONE MODEL\'S QUOTA RUNS OUT, THE NEXT MODEL OF THE SAME PROVIDER ANSWERS — and only that model waits', async () => {
  const { router, calls, recorded } = loadRouter({
    providers: [groq()],
    respond: ({ model }) => {
      if (model === 'openai/gpt-oss-20b') throw Object.assign(new Error(TPD), { status: 429 });
      return { text: 'ok', model, payload: {}, usage: null };
    },
  });
  const out = await router.runCapability({ capability: 'x', userText: 'hi' });
  assert.equal(out.model, 'openai/gpt-oss-120b');
  assert.deepEqual(calls, ['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
  assert.equal(recorded.cooled.length, 0, 'the provider is not cooled');
  assert.equal(recorded.paused.length, 1);
  assert.equal(recorded.paused[0].model, 'openai/gpt-oss-20b');
  const waitMs = new Date(recorded.paused[0].until).getTime() - Date.now();
  assert.ok(waitMs > 12 * 60_000 && waitMs < 13 * 60_000, `paused for the stated 12m35s, got ${waitMs}ms`);
});

test('a paused model is skipped until its time passes, and a model that answers loses its pause', async () => {
  const until = new Date(Date.now() + 3600_000).toISOString();
  const { router, calls, recorded } = loadRouter({
    providers: [groq({ modelCooldowns: { 'openai/gpt-oss-20b': { until }, 'openai/gpt-oss-120b': { until: '2000-01-01T00:00:00Z' } } })],
    respond: ({ model }) => ({ text: 'ok', model, payload: {}, usage: null }),
  });
  const out = await router.runCapability({ capability: 'x', userText: 'hi' });
  assert.deepEqual(calls, ['openai/gpt-oss-120b'], 'the paused model is not asked');
  assert.equal(out.model, 'openai/gpt-oss-120b');
  assert.deepEqual(recorded.cleared, [{ key: 'groq', model: 'openai/gpt-oss-120b' }], 'an expired pause is cleared on success');
  assert.equal(modelPause({ modelCooldowns: { m: { until } } }, 'm').until > Date.now(), true);
  assert.equal(modelPause({ modelCooldowns: { m: { until: 'garbage' } } }, 'm'), null);
});

test('with every model paused the provider is passed over, and the run says so', async () => {
  const until = new Date(Date.now() + 3600_000).toISOString();
  const { router, calls } = loadRouter({
    providers: [groq({ modelCooldowns: { 'openai/gpt-oss-20b': { until }, 'openai/gpt-oss-120b': { until } } })],
    respond: () => { throw new Error('must not be asked'); },
  });
  await assert.rejects(router.runCapability({ capability: 'x', userText: 'hi' }), (err) => {
    assert.equal(err.aiUnavailable, true);
    assert.match(err.message, /paused until/);
    return true;
  });
  assert.deepEqual(calls, []);
});
