const test = require('node:test');
const assert = require('node:assert/strict');

const groqCalls = [];
const geminiCalls = [];

require.cache[require.resolve('../services/groqClient')] = {
  exports: {
    callGroqWithFallback: async (prompt, opts) => {
      groqCalls.push({ prompt, opts });
      return { text: 'You still can\'t do this — step it up, bot.', model: 'test-groq' };
    },
    isAuthOrConfigError: () => false,
  },
};
require.cache[require.resolve('../services/geminiClient')] = {
  exports: {
    GEMINI_API_KEY: 'test-key',
    callGeminiJson: async (opts) => {
      geminiCalls.push(opts);
      return { text: 'Gemini roast', model: 'test-gemini' };
    },
  },
};

const {
  buildBanterPrompt,
  parseBanterResponse,
  pickFallbackLine,
  generateDatatruckBanterMessage,
} = require('../services/datatruckBanterMessage');

test('buildBanterPrompt includes failure snippet', () => {
  const prompt = buildBanterPrompt('Unknown command. Please use a valid command.');
  assert.match(prompt, /Unknown command/);
  assert.match(prompt, /playful roast/i);
});

test('parseBanterResponse strips fences and enforces max length', () => {
  const parsed = parseBanterResponse('```text\nShort roast here!\n```');
  assert.equal(parsed, 'Short roast here!');
  const long = 'x'.repeat(400);
  assert.equal(parseBanterResponse(long).length, 280);
});

test('generateDatatruckBanterMessage uses Groq when available', async () => {
  groqCalls.length = 0;
  const result = await generateDatatruckBanterMessage({
    failureSnippet: 'Unknown command.',
  });
  assert.equal(result.provider, 'groq');
  assert.match(result.message, /step it up/i);
  assert.equal(groqCalls.length, 1);
});

test('pickFallbackLine avoids excluded texts when possible', () => {
  const line = pickFallbackLine(['You gotta get smart, bot — that command was not it.']);
  assert.notEqual(line, 'You gotta get smart, bot — that command was not it.');
});

test('generateDatatruckBanterMessage falls back when Groq returns empty', async () => {
  require.cache[require.resolve('../services/groqClient')].exports.callGroqWithFallback = async () => ({
    text: '',
    model: 'test-groq',
  });
  require.cache[require.resolve('../services/geminiClient')].exports.callGeminiJson = async () => ({
    text: '',
    model: 'test-gemini',
  });
  delete require.cache[require.resolve('../services/datatruckBanterMessage')];
  const { generateDatatruckBanterMessage: genFallback } = require('../services/datatruckBanterMessage');

  const result = await genFallback({ failureSnippet: 'failed' });
  assert.equal(result.provider, 'fallback');
  assert.ok(result.message.length >= 8);
});
