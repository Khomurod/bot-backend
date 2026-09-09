/**
 * THE WHOLE APPLICATION WITH EVERY AI PROVIDER OFF.
 *
 * "Deterministic logic must not depend on AI" is easy to assert in prose and
 * hard to keep true, so this is the enforceable form: with the roster empty and
 * `ai_settings.enabled = false` — both supported, configurable states — the
 * features that have a deterministic path still answer, and the ones that do
 * not fail in the shape their callers already handle.
 *
 * It matters more since Stage 5c than it did before it. Until now `AI is off`
 * meant an unset environment variable, which nobody could do by accident. It is
 * now a switch in Admin → Settings → AI, one click, at any moment.
 *
 * The failure mode this guards against is subtle: not a crash, but a feature
 * that silently produces NOTHING where it used to produce a plain answer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROUTER = path.resolve(__dirname, '../services/ai/router.js');
const REGISTRY = path.resolve(__dirname, '../services/ai/registry.js');
const PROVIDERS = path.resolve(__dirname, '../database/aiProviders.js');
const SETTINGS = path.resolve(__dirname, '../database/aiSettings.js');
const CALL_LOG = path.resolve(__dirname, '../database/aiCallLog.js');
const OPENAI = path.resolve(__dirname, '../services/ai/adapters/openaiChat.js');
const GEMINI = path.resolve(__dirname, '../services/ai/adapters/gemini.js');

/**
 * The two ways AI is off, and they are NOT the same failure.
 *
 *   'disabled' — the master switch. A deliberate operator decision.
 *   'empty'    — enabled, but nothing on the roster can answer. What an
 *                unconfigured install and a database blip both look like.
 *
 * Both must reach the same deterministic answers, which is why every case below
 * runs against both.
 */
function loadWithAiOff(mode) {
  for (const p of [ROUTER, REGISTRY]) delete require.cache[p];

  const attempted = [];
  require.cache[PROVIDERS] = {
    exports: {
      async getProvidersForRouter() { return []; },
      async recordSuccess() {}, async recordFailure() {},
    },
  };
  require.cache[CALL_LOG] = { exports: { async recordAiCall() {} } };
  require.cache[SETTINGS] = {
    exports: {
      DEFAULTS: {}, invalidateCache() {},
      async getAiSettings() {
        return {
          enabled: mode !== 'disabled', freeOnlyMode: false, routingMode: 'priority',
          requestTimeoutMs: 1000, maxRetryWaitMs: 5000,
        };
      },
    },
  };
  const forbidden = async (args) => { attempted.push(args); throw new Error('must not be called'); };
  require.cache[OPENAI] = { exports: { callOpenAiChat: forbidden, DEFAULT_TIMEOUT_MS: 1000 } };
  require.cache[GEMINI] = { exports: { callGeminiGenerate: forbidden, DEFAULT_TIMEOUT_MS: 1000 } };

  return { attempted };
}

function freshRequire(relPath) {
  const full = require.resolve(relPath);
  delete require.cache[full];
  return require(full);
}

for (const mode of ['disabled', 'empty']) {
  test(`[${mode}] no provider is even contacted`, async () => {
    const { attempted } = loadWithAiOff(mode);
    const { runCapability, AiUnavailableError } = require(ROUTER);
    await assert.rejects(() => runCapability({ userText: 'hi' }),
      (err) => err instanceof AiUnavailableError);
    assert.deepEqual(attempted, [], 'an off roster must cost nothing, not one failed request');
  });

  test(`[${mode}] the Groq client fails in the shape its 22 call sites read`, async () => {
    loadWithAiOff(mode);
    const { callGroqWithFallback } = freshRequire('../services/groqClient');
    await assert.rejects(() => callGroqWithFallback('hi', {}), (err) => {
      assert.equal(err.aiUnavailable, true);
      assert.ok(Array.isArray(err.attemptErrors));
      assert.equal(err.allRateLimited, false);
      return true;
    });
  });

  test(`[${mode}] home-time intent still classifies deterministically`, async () => {
    loadWithAiOff(mode);
    const svc = freshRequire('../services/homeTimeIntentService');
    const det = svc.classifyDeterministically({
      triggerText: 'I want to go home next week',
      transcript: '', todayIso: '2026-09-09', hasOpenClarification: false,
    });
    assert.ok(det, 'the deterministic classifier is pure and must not need a provider');
    assert.ok(typeof det.intent === 'string');
  });

  test(`[${mode}] driver names still parse from the group title`, async () => {
    loadWithAiOff(mode);
    const { parseDriverFromGroupName } = freshRequire('../lib/drivers/driverProfileParse');
    const parsed = parseDriverFromGroupName('WENZE UNIT # 305 JOHN DOE (COMPANY DRIVERS)');
    assert.equal(parsed.first_name, 'JOHN');
    assert.equal(parsed.last_name, 'DOE');
    assert.equal(parsed.driver_type, 'company_driver');
  });

  test(`[${mode}] the unit parser is untouched by any of this`, async () => {
    loadWithAiOff(mode);
    const { extractUnitFromGroupName } = freshRequire('../lib/drivers/driverGroupTitle');
    assert.equal(extractUnitFromGroupName('WENZE UNIT # 4604 VALENTIN JOSEPH'), '4604');
  });
}

test('the master switch and an empty roster are told apart in the message', async () => {
  loadWithAiOff('disabled');
  const off = require(ROUTER);
  const disabledErr = await off.runCapability({ userText: 'x' }).catch((e) => e);
  assert.match(disabledErr.message, /switched off|no provider is configured/i);

  loadWithAiOff('empty');
  const empty = require(ROUTER);
  const emptyErr = await empty.runCapability({ userText: 'x' }).catch((e) => e);
  assert.ok(emptyErr.aiUnavailable,
    'both degrade the same way; only the wording an operator reads differs');
});
