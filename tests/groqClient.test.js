/**
 * `callGroqWithFallback` after Stage 5c: the same contract over a new transport.
 *
 * The signature and the failure shape are what ~22 call sites depend on, and
 * neither moved. What moved is underneath — the call now goes through
 * `services/ai/router.js`, so the key comes from the database (NULL inheriting
 * the environment), the model chain is an admin setting, and a failure is
 * classified rather than guessed at.
 *
 * ONE TEST HERE USED TO ASSERT THE BUG. "does not try other models on 403"
 * pinned `isAuthOrConfigError` aborting the whole chain on a rejected
 * credential — which with more than one provider turns one expired key into a
 * total AI outage. It is replaced below by the behaviour that is actually
 * wanted: stop asking THAT provider, and go on to the next one.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const CLIENT = path.resolve(__dirname, '../services/groqClient.js');
const ROUTER = path.resolve(__dirname, '../services/ai/router.js');
const REGISTRY = path.resolve(__dirname, '../services/ai/registry.js');
const OPENAI = path.resolve(__dirname, '../services/ai/adapters/openaiChat.js');
const GEMINI = path.resolve(__dirname, '../services/ai/adapters/gemini.js');
const PROVIDERS = path.resolve(__dirname, '../database/aiProviders.js');
const SETTINGS = path.resolve(__dirname, '../database/aiSettings.js');
const CALL_LOG = path.resolve(__dirname, '../database/aiCallLog.js');

const groq = (over = {}) => ({
  providerKey: 'groq', adapter: 'openai_chat', enabled: true, isFree: true, priority: 10,
  baseUrl: 'https://api.groq.com/openai/v1',
  modelChain: ['chain-1', 'chain-2'], apiKey: 'k', cooledUntil: null,
  consecutiveFailures: 0, ...over,
});

/** Load the client over a stubbed roster and adapter. No network, no database. */
function loadClient({ providers = [groq()], settings = {}, respond }) {
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

  const calls = [];
  const adapter = async (args) => {
    calls.push(args);
    return respond(args);
  };
  require.cache[OPENAI] = { exports: { callOpenAiChat: adapter, DEFAULT_TIMEOUT_MS: 1000 } };
  require.cache[GEMINI] = { exports: { callGeminiGenerate: adapter, DEFAULT_TIMEOUT_MS: 1000 } };

  return { client: require(CLIENT), calls };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const ok = ({ model }) => ({ text: 'hello', model, payload: {}, usage: null });

test('callGroqRaw still returns the assistant content', async () => {
  const { client } = loadClient({ respond: ok });
  assert.equal(await client.callGroqRaw('ping', { systemText: 'sys', maxTokens: 10 }), 'hello');
});

test('a caller that names NO model gets the admin-configured chain', async () => {
  // Not GROQ_AI_MODEL and its three env fallbacks: those are this module's
  // defaults, and putting them in front of the roster would mean the Settings
  // → AI model list was never reached on any call.
  const { client, calls } = loadClient({
    respond: ({ model }) => {
      if (model !== 'chain-2') throw httpError(503, 'unavailable');
      return { text: 'ok', model, payload: {}, usage: null };
    },
  });
  await client.callGroqWithFallback('ping', {});
  assert.deepEqual(calls.map((c) => c.model), ['chain-1', 'chain-2']);
});

test('the caller\'s models lead, and the configured chain follows', async () => {
  const { client, calls } = loadClient({
    respond: ({ model }) => {
      if (model !== 'chain-2') throw httpError(429, 'Rate limit reached. Please try again in 0.1s.');
      return { text: 'from-chain-2', model, payload: {}, usage: null };
    },
  });

  const result = await client.callGroqWithFallback('ping', { models: ['model-a', 'model-b'] });

  assert.equal(result.text, 'from-chain-2');
  assert.deepEqual(calls.map((c) => c.model), ['model-a', 'model-b', 'chain-1', 'chain-2'],
    'a fast model asked for on an interactive path is a deliberate latency choice; '
    + 'it leads, and the admin-configured chain is what comes after it');
});

test('generation options survive the trip', async () => {
  const { client, calls } = loadClient({
    respond: ({ model }) => ({ text: '{"ok":true}', model, payload: {}, usage: null }),
  });
  await client.callGroqWithFallback('ping', {
    models: ['m'], temperature: 0.9, maxTokens: 123, seed: 7,
    responseFormat: { type: 'json_object' },
  });
  assert.equal(calls[0].temperature, 0.9);
  assert.equal(calls[0].maxTokens, 123);
  assert.equal(calls[0].seed, 7);
  assert.deepEqual(calls[0].responseFormat, { type: 'json_object' });
});

test('a rejected credential reaches the NEXT PROVIDER instead of ending the call', async () => {
  // The old client threw here and stopped. One expired key was a total outage.
  const { client, calls } = loadClient({
    providers: [
      groq({ modelChain: ['chain-1'] }),
      groq({ providerKey: 'gemini', adapter: 'gemini', priority: 20, modelChain: ['gem-1'] }),
    ],
    respond: ({ model }) => {
      if (model === 'gem-1') return { text: 'answered', model, payload: {}, usage: null };
      throw httpError(403, 'forbidden');
    },
  });

  const result = await client.callGroqWithFallback('ping', { models: ['model-a'] });

  assert.equal(result.text, 'answered');
  assert.deepEqual(calls.map((c) => c.model), ['model-a', 'gem-1'],
    'and it stops asking Groq after the first refusal — a dead key is the same '
    + 'answer from every model that provider offers');
});

test('the failure shape all 22 call sites read is unchanged', async () => {
  const { client } = loadClient({
    respond: () => { throw httpError(429, 'Rate limit reached'); },
  });

  await assert.rejects(
    () => client.callGroqWithFallback('ping', { models: ['model-a'] }),
    (err) => {
      assert.ok(Array.isArray(err.attemptErrors), 'attemptErrors[] is the contract');
      assert.ok(err.attemptErrors.every((e) => 'model' in e && 'status' in e && 'message' in e));
      assert.equal(err.allRateLimited, true, 'aiAnnotationService reads this to set its cooldown');
      assert.match(err.message, /model-a/);
      return true;
    }
  );
});

test('AI switched off is a failure with the same shape, plus a flag', async () => {
  const { client } = loadClient({ settings: { enabled: false }, respond: ok });
  await assert.rejects(
    () => client.callGroqWithFallback('ping', {}),
    (err) => {
      assert.equal(err.aiUnavailable, true);
      assert.ok(Array.isArray(err.attemptErrors));
      assert.equal(err.allRateLimited, false, 'nothing was rate limited; nothing was asked');
      return true;
    }
  );
});

test('validateResult still rejects a bad answer and falls through', async () => {
  const { client, calls } = loadClient({
    respond: ({ model }) => ({ text: model === 'good' ? 'yes' : 'no', model, payload: {} }),
  });
  const result = await client.callGroqWithFallback('ping', {
    models: ['bad', 'good'],
    validateResult: (raw) => (raw === 'yes' ? true : { message: 'not yes' }),
  });
  assert.equal(result.model, 'good');
  assert.deepEqual(calls.map((c) => c.model), ['bad', 'good']);
});

test('parseRetryAfterMs still parses Groq\'s prose form', () => {
  const { client } = loadClient({ respond: ok });
  assert.equal(client.parseRetryAfterMs(null, 'Please try again in 10.5s'), 10500);
});
