const { test } = require('node:test');
const assert = require('node:assert/strict');

const originalFetch = global.fetch;
const originalKey = process.env.GROQ_API_KEY;
const originalFallback = process.env.GROQ_AI_FALLBACK_MODELS;

function mockFetch(handler) {
  global.fetch = handler;
}

function clearGroqCache() {
  delete require.cache[require.resolve('../services/groqClient')];
}

test('callGroqRaw returns assistant content on success', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  mockFetch(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content: '  hello  ' } }],
    }),
  }));

  clearGroqCache();
  const { callGroqRaw } = require('../services/groqClient');
  const out = await callGroqRaw('ping', { systemText: 'sys', maxTokens: 10 });
  assert.equal(out, 'hello');
});

test('callGroqWithFallback tries next model after 429', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  process.env.GROQ_AI_FALLBACK_MODELS = 'model-a,model-b';
  let calls = 0;
  mockFetch(async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    if (body.model === 'model-a') {
      return {
        ok: false,
        status: 429,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          error: { message: 'Rate limit reached for model `model-a`. Please try again in 0.1s.' },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: 'from-b' } }],
      }),
    };
  });

  clearGroqCache();
  const { callGroqWithFallback } = require('../services/groqClient');
  const result = await callGroqWithFallback('ping', {
    models: ['model-a', 'model-b'],
    maxRetryWaitMs: 500,
  });
  assert.equal(result.text, 'from-b');
  assert.equal(result.model, 'model-b');
  assert.ok(calls >= 2);
});

test('parseRetryAfterMs reads body hint', async () => {
  clearGroqCache();
  const { parseRetryAfterMs } = require('../services/groqClient');
  const ms = parseRetryAfterMs(null, 'Please try again in 10.5s');
  assert.equal(ms, 10500);
});

test('callGroqWithFallback does not try other models on 403', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  process.env.GROQ_AI_FALLBACK_MODELS = 'model-a,model-b';
  let calls = 0;
  mockFetch(async () => {
    calls += 1;
    return {
      ok: false,
      status: 403,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error: { message: 'forbidden' } }),
    };
  });

  clearGroqCache();
  const { callGroqWithFallback } = require('../services/groqClient');
  await assert.rejects(
    () => callGroqWithFallback('ping', { models: ['model-a', 'model-b'] }),
    (err) => err.message.includes('403') && calls === 1
  );
});

test.after(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) {
    delete process.env.GROQ_API_KEY;
  } else {
    process.env.GROQ_API_KEY = originalKey;
  }
  if (originalFallback === undefined) {
    delete process.env.GROQ_AI_FALLBACK_MODELS;
  } else {
    process.env.GROQ_AI_FALLBACK_MODELS = originalFallback;
  }
  clearGroqCache();
});
