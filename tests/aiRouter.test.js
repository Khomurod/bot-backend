/**
 * The routing loop. No network, no database — the adapters and the data layer
 * are replaced, and what is under test is the sequencing.
 *
 * The behaviours pinned here are the ones whose absence is expensive:
 *
 *   A dead key on the first provider must reach the second. `groqClient` aborts
 *   the whole chain on a 401 today, which with more than one provider turns an
 *   expired credential into a total AI outage.
 *
 *   Running out of providers is a NORMAL outcome, not a crash. With everything
 *   disabled — a supported mode — it is the only outcome, and every consumer is
 *   expected to reach its deterministic path.
 *
 *   The loop cannot spin, and it cannot take a provider off the roster.
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

const provider = (over = {}) => ({
  providerKey: 'groq', adapter: 'openai_chat', enabled: true, isFree: true, priority: 1,
  baseUrl: 'https://example.invalid/v1', modelChain: ['model-a'], apiKey: 'k',
  cooledUntil: null, consecutiveFailures: 0, ...over,
});

function loadRouter({ providers = [provider()], settings = {}, respond }) {
  for (const p of [ROUTER, REGISTRY]) delete require.cache[require.resolve(p)];

  const recorded = { cooled: [], success: [], log: [] };
  require.cache[PROVIDERS] = {
    exports: {
      async getProvidersForRouter() { return providers; },
      async recordSuccess(key) { recorded.success.push(key); },
      async recordFailure(key, args) { recorded.cooled.push({ key, ...args }); },
    },
  };
  require.cache[CALL_LOG] = {
    exports: { async recordAiCall(entry) { recorded.log.push(entry); } },
  };
  require.cache[path.resolve(__dirname, '../database/aiSettings.js')] = {
    exports: {
      DEFAULTS: {},
      invalidateCache() {},
      async getAiSettings() {
        return {
          enabled: true, freeOnlyMode: false, routingMode: 'priority',
          requestTimeoutMs: 1000, maxRetryWaitMs: 5000, ...settings,
        };
      },
    },
  };
  const calls = [];
  // The WHOLE argument object is recorded, not three fields of it. A test that
  // needs to prove the prompt actually arrived cannot do it from the model name.
  const adapter = async (args) => {
    calls.push(args);
    return respond(args);
  };
  require.cache[OPENAI] = { exports: { callOpenAiChat: adapter, DEFAULT_TIMEOUT_MS: 1000 } };
  require.cache[GEMINI] = { exports: { callGeminiGenerate: adapter, DEFAULT_TIMEOUT_MS: 1000 } };

  const router = require(ROUTER);
  return { router, calls, recorded };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ─── the defect this exists to fix ───────────────────────────────────────────

test('a dead key on the first provider reaches the second', async () => {
  const { router, calls } = loadRouter({
    providers: [
      provider({ providerKey: 'groq', priority: 1 }),
      provider({ providerKey: 'cerebras', priority: 2, modelChain: ['model-b'] }),
    ],
    respond: ({ model }) => {
      if (model === 'model-a') throw httpError(401, 'Invalid API key');
      return { text: 'answered', model, payload: {}, usage: null };
    },
  });

  const result = await router.runCapability({ capability: 'x', userText: 'hi' });

  assert.equal(result.provider, 'cerebras',
    'aborting here is what turns one expired credential into a total AI outage');
  assert.equal(result.text, 'answered');
  assert.deepEqual(calls.map((c) => c.model), ['model-a', 'model-b']);
});

test('a spent quota stops that provider without trying its other models', async () => {
  const { router, calls, recorded } = loadRouter({
    providers: [
      provider({ providerKey: 'groq', modelChain: ['a1', 'a2', 'a3'] }),
      provider({ providerKey: 'gemini', priority: 2, adapter: 'gemini', modelChain: ['g1'] }),
    ],
    respond: ({ model }) => {
      if (model.startsWith('a')) throw httpError(429, 'You exceeded your current quota');
      return { text: 'ok', model, payload: {}, usage: null };
    },
  });

  const result = await router.runCapability({ userText: 'hi' });

  assert.deepEqual(calls.map((c) => c.model), ['a1', 'g1'],
    'the same allowance covers every model, so asking a2 and a3 is pure waste');
  assert.equal(result.provider, 'gemini');
  assert.equal(recorded.cooled[0].key, 'groq');
  assert.match(recorded.cooled[0].cooldown.reason, /allowance is spent/);
});

// ─── running out is normal ───────────────────────────────────────────────────

test('with AI off, the consumer is told so and no call is attempted', async () => {
  const { router, calls } = loadRouter({
    settings: { enabled: false }, respond: () => { throw new Error('should not be called'); },
  });

  await assert.rejects(
    () => router.runCapability({ capability: 'home_time_intent', userText: 'hi' }),
    (err) => err.aiUnavailable === true
  );
  assert.deepEqual(calls, [], 'AI being off is a supported mode, not an outage');
});

test('every provider failing is an AiUnavailableError carrying every attempt', async () => {
  const { router } = loadRouter({
    providers: [
      provider({ providerKey: 'groq', modelChain: ['a'] }),
      provider({ providerKey: 'cerebras', priority: 2, modelChain: ['b'] }),
    ],
    respond: () => { throw httpError(500, 'Internal Server Error'); },
  });

  await assert.rejects(
    () => router.runCapability({ userText: 'hi' }),
    (err) => {
      assert.equal(err.aiUnavailable, true);
      assert.equal(err.attemptErrors.length, 2);
      assert.equal(err.allRateLimited, true, 'the shape aiAnnotationService already reads');
      return true;
    }
  );
});

// ─── a bad answer is a provider failure ──────────────────────────────────────

test('unparseable JSON falls through instead of reaching the consumer', async () => {
  const { router } = loadRouter({
    providers: [
      provider({ providerKey: 'groq', modelChain: ['a'] }),
      provider({ providerKey: 'cerebras', priority: 2, modelChain: ['b'] }),
    ],
    respond: ({ model }) => ({
      text: model === 'a' ? 'here you go: not json at all' : '{"ok":true}',
      model, payload: {}, usage: null,
    }),
  });

  const result = await router.runCapability({ userText: 'hi', expects: 'json' });

  assert.deepEqual(result.parsed, { ok: true });
  assert.equal(result.provider, 'cerebras');
});

test('a fenced JSON block is accepted, the way both existing clients accept it', async () => {
  const { router } = loadRouter({
    respond: ({ model }) => ({ text: '```json\n{"a":1}\n```', model, payload: {}, usage: null }),
  });

  const result = await router.runCapability({ userText: 'hi', expects: 'json' });
  assert.deepEqual(result.parsed, { a: 1 });
});

test("a capability's own validator can refuse an answer", async () => {
  const { router, calls } = loadRouter({
    providers: [
      provider({ providerKey: 'groq', modelChain: ['a'] }),
      provider({ providerKey: 'cerebras', priority: 2, modelChain: ['b'] }),
    ],
    respond: ({ model }) => ({ text: model === 'a' ? 'nope' : 'DRIVER: yes', model, payload: {}, usage: null }),
  });

  const result = await router.runCapability({
    userText: 'hi',
    validate: (text) => (text.startsWith('DRIVER:') ? true : { message: 'wrong shape' }),
  });

  assert.equal(result.provider, 'cerebras');
  assert.deepEqual(calls.map((c) => c.model), ['a', 'b']);
});

test('a refused answer never cools the provider that gave it', async () => {
  const { router, recorded } = loadRouter({
    respond: ({ model }) => ({ text: 'garbage', model, payload: {}, usage: null }),
  });

  await assert.rejects(() => router.runCapability({ userText: 'hi', expects: 'json' }));

  assert.deepEqual(recorded.cooled, [],
    'a model that answered badly once is not unwell');
});

// ─── the loop's own guarantees ───────────────────────────────────────────────

test('a cooled provider is skipped entirely', async () => {
  const { router, calls } = loadRouter({
    providers: [
      provider({ providerKey: 'groq', modelChain: ['a'], cooledUntil: Date.now() + 60_000 }),
      provider({ providerKey: 'cerebras', priority: 2, modelChain: ['b'] }),
    ],
    respond: ({ model }) => ({ text: 'ok', model, payload: {}, usage: null }),
  });

  const result = await router.runCapability({ userText: 'hi' });
  assert.deepEqual(calls.map((c) => c.model), ['b']);
  assert.equal(result.provider, 'cerebras');
});

test('free-only mode never calls a paid provider, even as a last resort', async () => {
  const { router, calls } = loadRouter({
    settings: { freeOnlyMode: true },
    providers: [
      provider({ providerKey: 'paid', priority: 1, isFree: false, modelChain: ['p'] }),
      provider({ providerKey: 'free', priority: 2, isFree: true, modelChain: ['f'] }),
    ],
    respond: ({ model }) => ({ text: 'ok', model, payload: {}, usage: null }),
  });

  const result = await router.runCapability({ userText: 'hi' });
  assert.deepEqual(calls.map((c) => c.model), ['f']);
  assert.equal(result.provider, 'free');
});

test('...and with only a paid provider, free-only means no call at all', async () => {
  const { router, calls } = loadRouter({
    settings: { freeOnlyMode: true },
    providers: [provider({ providerKey: 'paid', isFree: false })],
    respond: () => { throw new Error('should not be called'); },
  });

  await assert.rejects(() => router.runCapability({ userText: 'hi' }),
    (err) => err.aiUnavailable === true);
  assert.deepEqual(calls, [], 'an operator turned this on to GUARANTEE no paid call');
});

test('each provider is tried at most once, so the loop cannot spin', async () => {
  const { router, calls } = loadRouter({
    providers: [provider({ providerKey: 'groq', modelChain: ['a', 'b', 'c'] })],
    respond: () => { throw httpError(503, 'Service Unavailable'); },
  });

  await assert.rejects(() => router.runCapability({ userText: 'hi' }));
  assert.deepEqual(calls.map((c) => c.model), ['a', 'b', 'c'], 'every model once, then stop');
});

test('a success records health and a call-log row with no prompt in it', async () => {
  const { router, recorded } = loadRouter({
    respond: ({ model }) => ({ text: 'answered', model, payload: {}, usage: { prompt_tokens: 10 } }),
  });

  await router.runCapability({ capability: 'home_time_intent', userText: 'a driver said something' });

  assert.deepEqual(recorded.success, ['groq']);
  const [entry] = recorded.log;
  assert.equal(entry.outcome, 'ok');
  assert.equal(entry.capabilityKey, 'home_time_intent');
  assert.equal(entry.promptTokens, 10);
  assert.equal(JSON.stringify(entry).includes('a driver said something'), false,
    'no prompt, no completion, no PII');
});

test('a timeout is transient and moves on rather than aborting', async () => {
  const { router, calls } = loadRouter({
    providers: [
      provider({ providerKey: 'groq', modelChain: ['a'] }),
      provider({ providerKey: 'cerebras', priority: 2, modelChain: ['b'] }),
    ],
    respond: ({ model }) => {
      if (model === 'a') throw new Error('a: request timed out after 1000ms');
      return { text: 'ok', model, payload: {}, usage: null };
    },
  });

  const result = await router.runCapability({ userText: 'hi' });
  assert.equal(result.provider, 'cerebras');
  assert.deepEqual(calls.map((c) => c.model), ['a', 'b']);
});

// ─── two defects the Stage 5c rewiring introduced ────────────────────────────

test('an OpenAI-shaped `messages` prompt REACHES a Gemini provider', async () => {
  // `requestPinnedContextFromGroq` and `requestDispatchTemplateFromGroq` call
  // `callGroqWithFallback('')` and put the whole document in `messages`. When
  // the roster reached a Gemini provider, `buildRequest` built contents from
  // `userText` alone — an EMPTY prompt. A model asked nothing at all still
  // returns well-formed JSON, and those two sites validate the shape rather
  // than the truth, so a guessed pickup address would have passed straight
  // through as an extracted fact. The assertion is on the text, not on the
  // call: checking only that a call happened passes against the broken version.
  const { router, calls } = loadRouter({
    providers: [provider({ providerKey: 'gemini', adapter: 'gemini', modelChain: ['g1'] })],
    respond: ({ model }) => ({ text: 'ok', model, payload: {}, usage: null }),
  });

  await router.runCapability({
    userText: '',
    messages: [
      { role: 'system', content: 'You extract load data.' },
      { role: 'user', content: 'RATE CONFIRMATION — pickup Charlotte NC' },
    ],
  });

  assert.match(JSON.stringify(calls[0].contents), /RATE CONFIRMATION/,
    'the prompt must actually arrive');
  assert.deepEqual(calls[0].systemInstruction, { parts: [{ text: 'You extract load data.' }] });
});

test('an assistant turn becomes Gemini\'s `model` role', async () => {
  const { router, calls } = loadRouter({
    providers: [provider({ providerKey: 'gemini', adapter: 'gemini', modelChain: ['g1'] })],
    respond: ({ model }) => ({ text: 'ok', model, payload: {}, usage: null }),
  });

  await router.runCapability({
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ],
  });
  assert.deepEqual(calls[0].contents.map((c) => c.role), ['user', 'model', 'user']);
});

test('the ADMIN decides provider order, not the caller', async () => {
  // Every legacy call site sets `preferProvider: 'groq'`. Letting that reorder
  // the roster made the Settings → AI priority column decorative and meant
  // round-robin never rotated anything — Groq's allowance was burned first on
  // every call regardless of what an operator had configured.
  const { router, calls } = loadRouter({
    providers: [
      provider({ providerKey: 'cerebras', priority: 1, modelChain: ['cere-1'] }),
      provider({ providerKey: 'groq', priority: 2, modelChain: ['groq-1'] }),
    ],
    respond: ({ model }) => ({ text: 'ok', model, payload: {}, usage: null }),
  });

  const result = await router.runCapability({ userText: 'hi', preferProvider: 'groq' });

  assert.equal(result.provider, 'cerebras', 'priority 1 goes first, whoever the caller prefers');
  assert.deepEqual(calls.map((c) => c.model), ['cere-1']);
});

test('a caller\'s models still lead THEIR provider when the roster reaches it', async () => {
  // The legitimate half of the preference survives: model choice is a latency
  // decision somebody made on purpose. It just does not get to reorder the
  // roster to express it.
  const { router, calls } = loadRouter({
    providers: [
      provider({ providerKey: 'cerebras', priority: 1, modelChain: ['cere-1'] }),
      provider({ providerKey: 'groq', priority: 2, modelChain: ['groq-1'] }),
    ],
    respond: ({ model }) => {
      if (model !== 'fast-groq') throw httpError(503, 'unavailable');
      return { text: 'ok', model, payload: {}, usage: null };
    },
  });

  const result = await router.runCapability({
    userText: 'hi', preferProvider: 'groq', preferModels: ['fast-groq'],
  });

  assert.equal(result.model, 'fast-groq');
  assert.deepEqual(calls.map((c) => c.model), ['cere-1', 'fast-groq'],
    'cerebras first by priority; then groq, asked for the caller\'s model before '
    + 'its own chain — which answered, so the chain behind it was never needed');
});
