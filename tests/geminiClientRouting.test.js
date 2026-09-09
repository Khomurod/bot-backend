/**
 * The Gemini client after Stage 5c: the same contract over the AI router.
 *
 * Everything the ~20 Gemini call sites read is unchanged — `{ text, model,
 * payload }` from `callGeminiGenerateContent`, `{ parsed, text, model, payload }`
 * from `callGeminiJson`, and `attemptErrors[]` on failure. Underneath, the key
 * comes from the database (NULL inheriting `GEMINI_API_KEY`), the model chain is
 * an admin setting, and the call finally has a timeout.
 *
 * THE ONE THAT MATTERS MOST IS `requireAdapter`. A caller here has built
 * Gemini-shaped `contents`, and the home-time screenshot import sends IMAGES in
 * them. An OpenAI-compatible chat provider would accept the text half of that
 * request and answer confidently about a screenshot it never saw — a wrong
 * answer indistinguishable from a right one. Better to have no provider and let
 * the consumer degrade, which is what these tests pin.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const CLIENT = path.resolve(__dirname, '../services/geminiClient.js');
const ROUTER = path.resolve(__dirname, '../services/ai/router.js');
const REGISTRY = path.resolve(__dirname, '../services/ai/registry.js');
const OPENAI = path.resolve(__dirname, '../services/ai/adapters/openaiChat.js');
const GEMINI = path.resolve(__dirname, '../services/ai/adapters/gemini.js');
const PROVIDERS = path.resolve(__dirname, '../database/aiProviders.js');
const SETTINGS = path.resolve(__dirname, '../database/aiSettings.js');
const CALL_LOG = path.resolve(__dirname, '../database/aiCallLog.js');

const gemini = (over = {}) => ({
  providerKey: 'gemini', adapter: 'gemini', enabled: true, isFree: true, priority: 20,
  baseUrl: null, modelChain: ['gemini-3.1-flash-lite'], apiKey: 'k',
  cooledUntil: null, consecutiveFailures: 0, ...over,
});
const groq = (over = {}) => ({
  providerKey: 'groq', adapter: 'openai_chat', enabled: true, isFree: true, priority: 10,
  baseUrl: 'https://api.groq.com/openai/v1', modelChain: ['llama'], apiKey: 'k',
  cooledUntil: null, consecutiveFailures: 0, ...over,
});

function loadClient({ providers = [gemini()], settings = {}, respond }) {
  for (const p of [CLIENT, ROUTER, REGISTRY]) delete require.cache[p];

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
      async getAiSettings() {
        return {
          enabled: true, freeOnlyMode: false, routingMode: 'priority',
          requestTimeoutMs: 1000, maxRetryWaitMs: 5000, ...settings,
        };
      },
    },
  };

  const geminiCalls = [];
  const openaiCalls = [];
  require.cache[GEMINI] = {
    exports: {
      callGeminiGenerate: async (args) => { geminiCalls.push(args); return respond(args); },
      DEFAULT_TIMEOUT_MS: 1000,
    },
  };
  require.cache[OPENAI] = {
    exports: {
      callOpenAiChat: async (args) => { openaiCalls.push(args); return respond(args); },
      DEFAULT_TIMEOUT_MS: 1000,
    },
  };

  return { client: require(CLIENT), geminiCalls, openaiCalls };
}

const answers = (text) => ({ model }) => ({ text, model, payload: { candidates: [] }, usage: null });

test('callGeminiJson returns parsed, text, model and payload', async () => {
  const { client } = loadClient({ respond: answers('{"intent":"home"}') });
  const out = await client.callGeminiJson({ userText: 'hi' });
  assert.deepEqual(out.parsed, { intent: 'home' });
  assert.equal(out.text, '{"intent":"home"}');
  assert.equal(out.model, 'gemini-3.1-flash-lite');
  assert.ok(out.payload);
});

test('callGeminiText carries its generation config through', async () => {
  const { client, geminiCalls } = loadClient({ respond: answers('a reply') });
  await client.callGeminiText({ userText: 'hi', systemText: 'be brief', maxOutputTokens: 100 });
  assert.equal(geminiCalls[0].generationConfig.maxOutputTokens, 100);
  assert.equal(geminiCalls[0].generationConfig.responseMimeType, 'text/plain');
  assert.deepEqual(geminiCalls[0].systemInstruction, { parts: [{ text: 'be brief' }] });
});

test('an OpenAI-shaped provider is NEVER asked to answer Gemini-shaped contents', async () => {
  // Groq is priority 10 and would otherwise be first on the roster.
  const { client, openaiCalls, geminiCalls } = loadClient({
    providers: [groq(), gemini()],
    respond: answers('{"ok":true}'),
  });
  await client.callGeminiJson({ userText: 'hi' });
  assert.equal(openaiCalls.length, 0);
  assert.equal(geminiCalls.length, 1);
});

test('images have nowhere to go when no Gemini provider is on the roster', async () => {
  // The screenshot import. Failing here is correct: a text-only provider would
  // answer about an image it never received.
  const { client, openaiCalls } = loadClient({
    providers: [groq()],
    respond: answers('{"ok":true}'),
  });
  await assert.rejects(
    () => client.callGeminiJson({
      userText: 'read this',
      extraParts: [{ inline_data: { mime_type: 'image/png', data: 'x' } }],
    }),
    (err) => {
      assert.ok(Array.isArray(err.attemptErrors));
      assert.equal(err.aiUnavailable, true);
      return true;
    }
  );
  assert.equal(openaiCalls.length, 0, 'and it must not have been offered to one anyway');
});

test('images reach a Gemini provider intact', async () => {
  const image = { inline_data: { mime_type: 'image/png', data: 'x' } };
  const { client, geminiCalls } = loadClient({ respond: answers('{"unit":"305"}') });
  await client.callGeminiJson({ userText: 'read this', extraParts: [image] });
  assert.deepEqual(geminiCalls[0].contents[0].parts[1], image);
});

test('the failure shape every Gemini caller reads is unchanged', async () => {
  const { client } = loadClient({
    respond: () => { const e = new Error('429 quota exhausted'); e.status = 429; throw e; },
  });
  await assert.rejects(
    () => client.callGeminiText({ userText: 'hi' }),
    (err) => {
      assert.ok(err.attemptErrors.every((e) => 'model' in e && 'status' in e && 'message' in e));
      assert.match(err.message, /gemini-3\.1-flash-lite/);
      return true;
    }
  );
});

test('non-JSON from a model falls through instead of reaching the consumer', async () => {
  const { client, geminiCalls } = loadClient({
    providers: [gemini({ modelChain: ['m1', 'm2'] })],
    respond: ({ model }) => ({
      text: model === 'm2' ? '{"ok":true}' : 'sorry, I cannot',
      model, payload: {}, usage: null,
    }),
  });
  const out = await client.callGeminiJson({ userText: 'hi' });
  assert.deepEqual(out.parsed, { ok: true });
  assert.deepEqual(geminiCalls.map((c) => c.model), ['m1', 'm2']);
});

test('AI switched off degrades rather than throwing something new', async () => {
  const { client } = loadClient({ settings: { enabled: false }, respond: answers('x') });
  await assert.rejects(
    () => client.callGeminiJson({ userText: 'hi' }),
    (err) => err.aiUnavailable === true && Array.isArray(err.attemptErrors)
  );
});
