/**
 * The nine gates that still asked the ENVIRONMENT whether AI exists.
 *
 * `const { GROQ_API_KEY } = require('./groqClient')` reads a module-level
 * constant at REQUIRE time. That was correct while the environment was the only
 * place a key could live. Since Stage 5 a key can live in the database instead,
 * and Stage 5c moved every call onto the router — so these gates were the last
 * place the old world survived, and they were wrong in both directions:
 *
 *   an operator who moves a key into Admin → Settings → AI and clears the env
 *   var loses these features silently, with nothing failing and nothing said;
 *
 *   an operator who turns the master switch OFF still reads "configured" here,
 *   so the feature tries, fails through the router, and reports an error rather
 *   than a clean "AI is not configured".
 *
 * A destructured constant cannot be made dynamic — a getter on `module.exports`
 * is snapshotted by the import — so each gate had to move to `isAiAvailable()`,
 * which answers from the 30-second roster cache.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REGISTRY = path.resolve(__dirname, '../services/ai/registry.js');
const PROVIDERS = path.resolve(__dirname, '../database/aiProviders.js');
const SETTINGS = path.resolve(__dirname, '../database/aiSettings.js');

/** Stand the roster up in one of its three real states. */
function loadRegistry({ enabled = true, providers = [{ providerKey: 'groq', apiKey: 'k' }], throws = false }) {
  delete require.cache[REGISTRY];
  require.cache[PROVIDERS] = {
    exports: {
      async getProvidersForRouter() {
        if (throws) throw new Error('connection refused');
        return providers;
      },
      async recordSuccess() {}, async recordFailure() {},
    },
  };
  require.cache[SETTINGS] = {
    exports: {
      DEFAULTS: {},
      invalidateCache() {},
      async getAiSettings() {
        if (throws) throw new Error('connection refused');
        return { enabled, freeOnlyMode: false, routingMode: 'priority' };
      },
    },
  };
  return require(REGISTRY);
}

test('a provider with a key is available', async () => {
  const registry = loadRegistry({});
  assert.equal(await registry.isAiAvailable(), true);
});

test('the master switch OFF is not available', async () => {
  // One click in the admin, and every gate must see it — this is the direction
  // an env-var check could never have covered at all.
  const registry = loadRegistry({ enabled: false });
  assert.equal(await registry.isAiAvailable(), false);
});

test('an empty roster is not available', async () => {
  const registry = loadRegistry({ providers: [] });
  assert.equal(await registry.isAiAvailable(), false);
});

test('a provider with NO key is not a provider', async () => {
  const registry = loadRegistry({ providers: [{ providerKey: 'groq', apiKey: '' }] });
  assert.equal(await registry.isAiAvailable(), false);
});

test('an unreachable database answers "off", it does not throw', async () => {
  // Every caller of this has a deterministic path or an explicit failure it
  // already handles. A gate that threw would turn a database blip into a
  // different, worse failure inside twenty-odd features.
  const registry = loadRegistry({ throws: true });
  assert.equal(await registry.isAiAvailable(), false);
});

test('a key stored ONLY in the database still counts', async () => {
  // The whole point. `getProvidersForRouter` decrypts the stored key and falls
  // back to the env var; a consumer gate reading `process.env` directly would
  // have said "not configured" here and skipped the feature in silence.
  const before = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  try {
    const registry = loadRegistry({ providers: [{ providerKey: 'groq', apiKey: 'from-the-database' }] });
    assert.equal(await registry.isAiAvailable(), true);
  } finally {
    if (before === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = before;
  }
});

test('no consumer still reads an AI key constant from a client module', () => {
  // The enforceable form. A destructured module-level constant cannot be made
  // dynamic, so a new one would silently reintroduce exactly this bug — and it
  // would pass every test, because the env var is set in production.
  const fs = require('node:fs');
  const files = [
    'services/translationService.js',
    'services/datatruckBanterMessage.js',
    'services/aiAnnotationService.js',
    'services/groupStatusAiClassifier.js',
    'services/employeeBirthdayMessage.js',
    'services/pinnedContext/loadContextFromText.js',
    // `server/services/dispatchParser/aiRequests.js` was here until the Dispatch
    // Center was removed — it held the Groq and Gemini reads for the Send Load
    // tab's rate-confirmation parser, and went with it. A file that no longer
    // exists cannot reintroduce the gate, and listing it would only fail on
    // ENOENT and say nothing about the rule.
  ];
  // Comments are stripped first: several of these files EXPLAIN the old gate,
  // and banning the explanation along with the code would push out the reason
  // the change was made.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  for (const file of files) {
    const code = stripComments(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'));
    assert.equal(/\bGROQ_API_KEY\b|\bGEMINI_API_KEY\b/.test(code), false,
      `${file} still gates on an environment key read at require time`);
  }
});
