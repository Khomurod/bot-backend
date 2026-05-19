const { test } = require('node:test');
const assert = require('node:assert/strict');

const originalFetch = global.fetch;
const originalKey = process.env.GROQ_API_KEY;

test('callGroqRaw returns assistant content on success', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content: '  hello  ' } }],
    }),
  });

  delete require.cache[require.resolve('../services/groqClient')];
  const { callGroqRaw } = require('../services/groqClient');
  const out = await callGroqRaw('ping', { systemText: 'sys', maxTokens: 10 });
  assert.equal(out, 'hello');
});

test('callGroqRaw does not retry on 403', async () => {
  process.env.GROQ_API_KEY = 'test-key';
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return {
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: { message: 'forbidden' } }),
    };
  };

  delete require.cache[require.resolve('../services/groqClient')];
  const { callGroqRaw } = require('../services/groqClient');
  await assert.rejects(
    () => callGroqRaw('ping'),
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
  delete require.cache[require.resolve('../services/groqClient')];
});
