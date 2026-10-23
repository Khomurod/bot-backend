'use strict';

/**
 * The owner's rule (23 October 2026): free models first; if they are less than
 * 85% sure, Claude (Sonnet, then Haiku); if Claude cannot be reached, another
 * strong model; if nobody better answers, the free answer comes back marked
 * uncertain. Only decisions escalate. The adapters are replaced.
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

const {
  normaliseConfidence, assessAnswer, claudeEscalationChain, escalates,
} = require('../lib/ai/escalation');

const groq = (over = {}) => ({
  providerKey: 'groq', adapter: 'openai_chat', enabled: true, isFree: true, priority: 10,
  baseUrl: 'https://example.invalid/v1', modelChain: ['llama'], apiKey: 'k',
  cooledUntil: null, consecutiveFailures: 0, ...over,
});
const claude = (over = {}) => ({
  providerKey: 'anthropic', adapter: 'anthropic', enabled: true, isFree: false, priority: 20,
  baseUrl: 'https://api.anthropic.com', modelChain: ['claude-haiku-5-5'],
  discoveredModelIds: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-4-5'],
  apiKey: 'sk-ant-k', cooledUntil: null, consecutiveFailures: 0, ...over,
});
const paid = (over = {}) => groq({ providerKey: 'openrouter', isFree: false, priority: 30, modelChain: ['big'], ...over });

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

const json = (obj) => ({ text: JSON.stringify(obj), model: null, payload: {}, usage: null });
const byAdapter = (answers) => (args) => {
  const a = answers[args.adapter];
  if (a instanceof Error) throw a;
  return { ...json(typeof a === 'function' ? a(args) : a), model: args.model };
};
const decision = { capability: 'hiring_stage_reading', systemText: 'Read it. Answer with JSON only.', userText: 'x', expects: 'json' };

test('a free answer at least 85% sure stands; Claude is not asked', async () => {
  const { router, calls } = loadRouter({
    providers: [groq(), claude()],
    respond: byAdapter({ openai_chat: { move: false, confidence: 92 } }),
  });
  const out = await router.runCapability(decision);
  assert.equal(out.stage, 'free');
  assert.equal(out.uncertain, false);
  assert.deepEqual(calls.map((c) => c.adapter), ['openai_chat']);
});

test('under 85%: Claude is asked — Sonnet first — and its answer stands', async () => {
  const { router, calls } = loadRouter({
    providers: [groq(), claude()],
    respond: byAdapter({ openai_chat: { move: false, confidence: 60 }, anthropic: { move: true, stage_id: 'S2', confidence: 95 } }),
  });
  const out = await router.runCapability(decision);
  assert.equal(out.stage, 'claude');
  assert.equal(out.parsed.stage_id, 'S2');
  assert.equal(calls[1].model, 'claude-sonnet-5-5', 'the newest Sonnet, never Opus');
});

test('Sonnet cannot answer: Haiku', async () => {
  const sonnetDown = Object.assign(new Error('529 overloaded'), { status: 529 });
  const { router, calls } = loadRouter({
    providers: [groq(), claude()],
    respond: (args) => {
      if (args.adapter === 'openai_chat') return json({ move: false, confidence: 40 });
      if (args.model === 'claude-sonnet-5-5') throw sonnetDown;
      return { ...json({ move: false, confidence: 90 }), model: args.model };
    },
  });
  const out = await router.runCapability(decision);
  assert.equal(out.stage, 'claude');
  assert.deepEqual(calls.filter((c) => c.adapter === 'anthropic').map((c) => c.model), ['claude-sonnet-5-5', 'claude-haiku-5-5']);
});

test('Claude unreachable: another strong model; nobody: the free answer, marked uncertain', async () => {
  const down = Object.assign(new Error('401 invalid key'), { status: 401 });
  const strong = loadRouter({
    providers: [groq(), claude(), paid()],
    respond: (args) => {
      if (args.adapter === 'anthropic') throw down;
      return json(args.model === 'big' ? { move: false, confidence: 88 } : { move: false, confidence: 50 });
    },
  });
  const viaStrong = await strong.router.runCapability(decision);
  assert.equal(viaStrong.stage, 'strong');

  const alone = loadRouter({ providers: [groq()], respond: byAdapter({ openai_chat: { move: true, stage_id: 'S1', confidence: 50 } }) });
  const out = await alone.router.runCapability(decision);
  assert.equal(out.stage, 'free');
  assert.equal(out.uncertain, true);
  assert.equal(out.parsed.stage_id, 'S1', 'the answer is still there for the consumer\'s own gate');
});

test('"Free tiers only" never reaches Claude', async () => {
  const { router, calls } = loadRouter({
    providers: [groq(), claude()],
    settings: { freeOnlyMode: true },
    respond: byAdapter({ openai_chat: { move: false, confidence: 10 } }),
  });
  const out = await router.runCapability(decision);
  assert.equal(out.uncertain, true);
  assert.ok(calls.every((c) => c.adapter !== 'anthropic'));
});

test('"unclear" escalates whatever the confidence; a reply the model was sure of does not', async () => {
  const { router, calls } = loadRouter({
    providers: [groq(), claude()],
    respond: byAdapter({ openai_chat: { action: 'unclear', confidence: 99 }, anthropic: { action: 'resolve', confidence: 90 } }),
  });
  const out = await router.runCapability({ ...decision, capability: 'control_reply_reading' });
  assert.equal(out.stage, 'claude');
  assert.equal(calls.length, 2);
});

test('the free model is asked for a confidence once — and not when the prompt already has one', async () => {
  const { router, calls } = loadRouter({ providers: [groq()], respond: byAdapter({ openai_chat: { confidence: 90 } }) });
  await router.runCapability(decision);
  assert.match(calls[0].messages[0].content, /"confidence": a number from 0 to 100/);
  const own = 'Answer {"returned":true|false,"confidence":0-100}';
  await router.runCapability({ ...decision, systemText: own });
  assert.equal(calls[1].messages[0].content, own);
});

test('text for people, and every non-decision, is one pass in the admin\'s order as before', async () => {
  const { router, calls } = loadRouter({
    providers: [claude({ priority: 1 }), groq()],
    respond: (args) => ({ text: 'Happy birthday!', model: args.model, payload: {}, usage: null }),
  });
  const out = await router.runCapability({ capability: 'employee_birthday_message', userText: 'write' });
  assert.equal(out.provider, 'anthropic');
  assert.equal(calls.length, 1);
  assert.equal(out.stage, undefined);
});

test('confidence in every shape a model writes it', () => {
  assert.equal(normaliseConfidence(87), 87);
  assert.equal(normaliseConfidence('87%'), 87);
  assert.equal(normaliseConfidence(0.87), 87);
  assert.equal(normaliseConfidence('high'), 90);
  assert.equal(normaliseConfidence('low'), 30);
  assert.equal(normaliseConfidence(null), null);
  assert.equal(normaliseConfidence('sure'), null);
});

test('assessAnswer: under the bar, no confidence, or "unclear" is unsure', () => {
  assert.equal(assessAnswer('hiring_stage_reading', { confidence: 85 }).sure, true);
  assert.equal(assessAnswer('hiring_stage_reading', { confidence: 84 }).why, 'low_confidence');
  assert.equal(assessAnswer('hiring_stage_reading', {}).why, 'no_confidence');
  assert.equal(assessAnswer('safety_approval_reading', {
    confidence: 99, decisions: [{ decision: 'unclear' }],
  }).why, 'said_unclear');
  assert.equal(escalates('employee_birthday_message'), false);
  assert.equal(escalates('home_time_intent'), true);
});

test('Claude chain: newest Sonnet, then newest Haiku — never Opus', () => {
  assert.deepEqual(
    claudeEscalationChain(['claude-opus-5-5', 'claude-sonnet-4-5-20250929', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-haiku-5-5']),
    ['claude-sonnet-5-5', 'claude-haiku-5-5'],
  );
  assert.deepEqual(claudeEscalationChain([], ['claude-opus-5-5']), ['claude-opus-5-5'], 'nothing better known: the operator\'s chain');
});
