/**
 * The Send Message (broadcast) auto-translate feature must run on the app's
 * integrated AI stack, with no Send-Message-specific provider, key or model.
 *
 * Since Stage 5c that stack is ONE call through the shared client, with
 * cross-provider fallback handled by the router — so the cases that used to
 * assert "Groq failed, therefore Gemini was called" now belong to the router's
 * own suite, and what this file pins is that translation asks the ROSTER whether
 * AI exists rather than reading an environment variable. A key configured only
 * in Admin → Settings → AI is a configured key, and the master switch being off
 * is a reason to say "not configured" that no env check could ever see.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const servicePath = path.resolve(__dirname, '../services/translationService.js');
const groqPath = path.resolve(__dirname, '../services/groqClient.js');
const geminiPath = path.resolve(__dirname, '../services/geminiClient.js');

const registryPath = path.resolve(__dirname, '../services/ai/registry.js');

function loadService({ aiAvailable = false, groqImpl, geminiImpl } = {}) {
  delete require.cache[servicePath];

  const calls = { groq: [], gemini: [] };

  require.cache[groqPath] = {
    exports: {
      async callGroqWithFallback(promptText, opts = {}) {
        calls.groq.push({ promptText, opts });
        if (!groqImpl) throw new Error('groq not stubbed');
        return groqImpl(promptText, opts);
      },
    },
  };
  require.cache[geminiPath] = {
    exports: {
      async callGeminiJson(opts = {}) {
        calls.gemini.push(opts);
        if (!geminiImpl) throw new Error('gemini not stubbed');
        return geminiImpl(opts);
      },
    },
  };
  require.cache[registryPath] = {
    exports: { async isAiAvailable() { return aiAvailable; } },
  };

  const service = require(servicePath);
  return { service, calls };
}

test('translateBatch uses the integrated Groq client', async () => {
  const { service, calls } = loadService({
    aiAvailable: true,
    groqImpl: () => ({ text: JSON.stringify({ translations: ['Привет', 'Пока'] }), model: 'llama' }),
  });

  const out = await service.translateBatch(['Hello', 'Bye'], 'ru');
  assert.deepEqual(out, ['Привет', 'Пока']);
  assert.equal(calls.groq.length, 1, 'the shared client is called exactly once');
  assert.equal(calls.gemini.length, 0,
    'no second leg here — cross-provider fallback is the router\'s job now');
  assert.match(calls.groq[0].opts.systemText, /professional translator/);
});

test('a provider failure is NOT retried here', async () => {
  // This used to assert "Groq failed, so Gemini was called". That second leg was
  // hand-coded cross-provider fallback gated on an environment key; the router
  // owns it now, so translation makes one call and lets it fail. Asserting the
  // old behaviour here would have re-created the branch it replaced.
  const { service, calls } = loadService({
    aiAvailable: true,
    groqImpl: () => { throw new Error('rate limited'); },
  });

  await assert.rejects(() => service.translateBatch(['Hello'], 'uz'), /rate limited/);
  assert.equal(calls.groq.length, 1);
  assert.equal(calls.gemini.length, 0);
});

test('a key that lives only in the admin still counts as configured', async () => {
  // The reason this moved off `GROQ_API_KEY`: an operator who stores their key
  // in Admin → Settings → AI and clears the env var would have been told "AI is
  // not configured" while their key sat in the database.
  const { service, calls } = loadService({
    aiAvailable: true,
    groqImpl: () => ({ text: JSON.stringify({ translations: ['Salom'] }), model: 'llama' }),
  });

  assert.equal(await service.isTranslationAiConfigured(), true);
  assert.deepEqual(await service.translateBatch(['Hello'], 'uz'), ['Salom']);
  assert.equal(calls.groq.length, 1);
});

test('the master switch OFF is a clear "not configured", not a provider error', async () => {
  const { service, calls } = loadService({});

  assert.equal(await service.isTranslationAiConfigured(), false);
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
    aiAvailable: true,
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
