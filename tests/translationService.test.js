/**
 * The Send Message (broadcast) auto-translate feature must run on the app's
 * integrated AI stack — the shared Groq client with Gemini fallback — with no
 * Send-Message-specific provider, key, or model. Clients are faked via
 * require.cache so no network or env keys are needed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const servicePath = path.resolve(__dirname, '../services/translationService.js');
const groqPath = path.resolve(__dirname, '../services/groqClient.js');
const geminiPath = path.resolve(__dirname, '../services/geminiClient.js');

function loadService({ groqKey = '', geminiKey = '', groqImpl, geminiImpl } = {}) {
  delete require.cache[servicePath];

  const calls = { groq: [], gemini: [] };

  require.cache[groqPath] = {
    exports: {
      GROQ_API_KEY: groqKey,
      async callGroqWithFallback(promptText, opts = {}) {
        calls.groq.push({ promptText, opts });
        if (!groqImpl) throw new Error('groq not stubbed');
        return groqImpl(promptText, opts);
      },
    },
  };
  require.cache[geminiPath] = {
    exports: {
      GEMINI_API_KEY: geminiKey,
      async callGeminiJson(opts = {}) {
        calls.gemini.push(opts);
        if (!geminiImpl) throw new Error('gemini not stubbed');
        return geminiImpl(opts);
      },
    },
  };

  const service = require(servicePath);
  return { service, calls };
}

test('translateBatch uses the integrated Groq client', async () => {
  const { service, calls } = loadService({
    groqKey: 'groq-test-key',
    groqImpl: () => ({ text: JSON.stringify({ translations: ['Привет', 'Пока'] }), model: 'llama' }),
  });

  const out = await service.translateBatch(['Hello', 'Bye'], 'ru');
  assert.deepEqual(out, ['Привет', 'Пока']);
  assert.equal(calls.groq.length, 1, 'Groq client called once');
  assert.equal(calls.gemini.length, 0, 'Gemini not needed when Groq succeeds');
  assert.match(calls.groq[0].opts.systemText, /professional translator/);
});

test('falls back to the integrated Gemini client when Groq fails', async () => {
  const { service, calls } = loadService({
    groqKey: 'groq-test-key',
    geminiKey: 'gemini-test-key',
    groqImpl: () => { throw new Error('rate limited'); },
    geminiImpl: () => ({ text: JSON.stringify({ translations: ['Salom'] }), model: 'gemini' }),
  });

  const out = await service.translateBatch(['Hello'], 'uz');
  assert.deepEqual(out, ['Salom']);
  assert.equal(calls.groq.length, 1);
  assert.equal(calls.gemini.length, 1, 'fell back to Gemini');
});

test('uses Gemini directly when only Gemini is configured', async () => {
  const { service, calls } = loadService({
    geminiKey: 'gemini-test-key',
    geminiImpl: () => ({ text: JSON.stringify({ translations: ['Привет'] }), model: 'gemini' }),
  });

  const out = await service.translateBatch(['Hello'], 'ru');
  assert.deepEqual(out, ['Привет']);
  assert.equal(calls.groq.length, 0);
  assert.equal(calls.gemini.length, 1);
});

test('throws the clear not-configured error when the integrated AI has no keys', async () => {
  const { service, calls } = loadService({});

  assert.equal(service.isTranslationAiConfigured(), false);
  await assert.rejects(
    () => service.translateBatch(['Hello'], 'ru'),
    (err) => {
      assert.equal(err.message, service.AI_NOT_CONFIGURED_MESSAGE);
      assert.equal(err.code, 'AI_NOT_CONFIGURED');
      assert.equal(err.statusCode, 503);
      return true;
    }
  );
  assert.equal(calls.groq.length, 0, 'no provider call is attempted');
  assert.equal(calls.gemini.length, 0);
  assert.match(service.AI_NOT_CONFIGURED_MESSAGE, /AI is not configured/);
});

test('translateText delegates to the same integrated pipeline', async () => {
  const { service, calls } = loadService({
    groqKey: 'groq-test-key',
    groqImpl: () => ({ text: JSON.stringify({ translations: ['Привет'] }), model: 'llama' }),
  });

  assert.equal(await service.translateText('Hello', 'ru'), 'Привет');
  assert.equal(await service.translateText('   ', 'ru'), '', 'blank input short-circuits');
  assert.equal(calls.groq.length, 1);
});

test('no Send-Message-specific AI provider/key/model remains anywhere', () => {
  const serviceSrc = fs.readFileSync(servicePath, 'utf8');
  assert.ok(!/openai/i.test(serviceSrc), 'translationService must not reference OpenAI');

  const configSrc = fs.readFileSync(path.resolve(__dirname, '../config/config.js'), 'utf8');
  assert.ok(!/OPENAI_API_KEY|openaiApiKey/.test(configSrc), 'config must not carry an OpenAI key');

  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
  assert.ok(!pkg.dependencies?.openai, 'openai dependency removed');
  assert.ok(!pkg.devDependencies?.openai, 'openai devDependency removed');
});
