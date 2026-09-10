/**
 * Admin → Settings → AI, on the two promises it makes.
 *
 *   A STORED SECRET IS NEVER RETURNED IN FULL. That invariant is stated for
 *   every settings sub-router in this directory, and it is one assertion away
 *   from being broken by a mapper that grows a field.
 *
 *   `/test` PROVES THE KEY YOU JUST TYPED. Testing the stored one would only
 *   report the state the operator is already in; testing the candidate is what
 *   stops a typo becoming a provider that fails silently at the next real call.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const ROUTE = path.resolve(__dirname, '../server/routes/settings/aiRoutes.js');
const OPENAI = path.resolve(__dirname, '../services/ai/adapters/openaiChat.js');
const GEMINI = path.resolve(__dirname, '../services/ai/adapters/gemini.js');
const REGISTRY = path.resolve(__dirname, '../services/ai/registry.js');

function loadApp({ adapterImpl, providers = [], storedKey = '' } = {}) {
  delete require.cache[require.resolve(ROUTE)];
  const saw = { adapter: [], upserts: [], invalidated: 0 };

  require.cache[path.resolve(__dirname, '../database/aiSettings.js')] = {
    exports: {
      async getAiSettings() { return { enabled: true, freeOnlyMode: true, routingMode: 'priority' }; },
      async updateAiSettings(patch) { return { ...patch, saved: true }; },
      async listCapabilities() { return []; },
      async updateCapability(key, patch) { return { capabilityKey: key, ...patch }; },
      invalidateCache() {},
      DEFAULTS: {},
    },
  };
  require.cache[path.resolve(__dirname, '../database/aiProviders.js')] = {
    exports: {
      async listProvidersForAdmin() { return providers; },
      async getProvidersForRouter() {
        return [{ providerKey: 'groq', apiKey: storedKey }];
      },
      async upsertProvider(key, patch) { saw.upserts.push({ key, ...patch }); return { providerKey: key }; },
      async deleteProvider() { return true; },
      async clearCooldown(key) { return { providerKey: key, cooledUntil: null }; },
    },
  };
  require.cache[path.resolve(__dirname, '../database/aiCallLog.js')] = {
    exports: {
      async summariseProviderHealth() { return []; },
      async listRecentFailures() { return []; },
    },
  };
  require.cache[path.resolve(__dirname, '../database/aiModelEvents.js')] = {
    exports: { async listModelEvents() { return []; }, async recordModelEvent() {} },
  };
  require.cache[REGISTRY] = {
    exports: { invalidateRegistry() { saw.invalidated += 1; }, getRoster: async () => ({}) },
  };
  const adapter = async (args) => { saw.adapter.push(args); return adapterImpl(args); };
  require.cache[OPENAI] = { exports: { callOpenAiChat: adapter, DEFAULT_TIMEOUT_MS: 1000 } };
  require.cache[GEMINI] = { exports: { callGeminiGenerate: adapter, DEFAULT_TIMEOUT_MS: 1000 } };

  const { createAiSettingsRouter } = require(ROUTE);
  const app = express();
  app.use(express.json());
  app.use('/api/settings', createAiSettingsRouter({
    authMiddleware: (req, _res, next) => { req.admin = { username: 'admin' }; next(); },
  }));
  return { app, saw };
}

async function call(app, method, url, body) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { server.close(); }
}

test('the read never carries a usable key', async () => {
  const { app } = loadApp({
    providers: [{
      providerKey: 'groq', label: 'Groq', apiKeySet: true,
      apiKeyMasked: '••••ABCD', apiKeyFromEnv: false,
    }],
    adapterImpl: () => ({ text: 'ok' }),
  });

  const res = await call(app, 'GET', '/api/settings/ai');

  assert.equal(res.status, 200);
  assert.equal(res.body.providers[0].apiKeyMasked, '••••ABCD');
  assert.equal(JSON.stringify(res.body).includes('apiKey"'), false);
});

test('/test exercises the key from the request body, not the stored one', async () => {
  const { app, saw } = loadApp({
    storedKey: 'the_OLD_key', adapterImpl: () => ({ text: 'ok', model: 'm' }),
  });

  const res = await call(app, 'POST', '/api/settings/ai/providers/groq/test', {
    apiKey: 'the_NEW_key', model: 'llama-3.1-8b-instant', baseUrl: 'https://x/v1',
  });

  assert.equal(res.body.ok, true);
  assert.equal(saw.adapter[0].apiKey, 'the_NEW_key',
    'proving the key you just typed is the whole point');
});

test('...and falls back to the stored key when the field is left blank', async () => {
  const { app, saw } = loadApp({
    storedKey: 'the_OLD_key', adapterImpl: () => ({ text: 'ok', model: 'm' }),
  });

  await call(app, 'POST', '/api/settings/ai/providers/groq/test', { model: 'm' });

  assert.equal(saw.adapter[0].apiKey, 'the_OLD_key');
});

test('a rejected key is a 200 with ok:false and a CLASS, not a server error', async () => {
  const { app } = loadApp({
    adapterImpl: () => { const e = new Error('401 Invalid API key'); e.status = 401; throw e; },
  });

  const res = await call(app, 'POST', '/api/settings/ai/providers/groq/test', {
    apiKey: 'wrong', model: 'm',
  });

  assert.equal(res.status, 200,
    'the request succeeded; what failed is the thing being tested');
  assert.equal(res.body.ok, false);
  assert.equal(res.body.failureKind, 'credential');
});

test('a spent free tier is reported as quota, not as a bad key', async () => {
  const { app } = loadApp({
    adapterImpl: () => {
      const e = new Error('429 You exceeded your current quota');
      e.status = 429;
      throw e;
    },
  });

  const res = await call(app, 'POST', '/api/settings/ai/providers/groq/test', {
    apiKey: 'fine', model: 'm',
  });

  assert.equal(res.body.failureKind, 'quota',
    'these look identical in a raw error string and mean completely different things');
});

test('a test needs a model to test with', async () => {
  const { app } = loadApp({ adapterImpl: () => ({ text: 'ok' }) });
  const res = await call(app, 'POST', '/api/settings/ai/providers/groq/test', { apiKey: 'k' });
  assert.equal(res.status, 400);
});

test('saving anything invalidates the router cache', async () => {
  const { app, saw } = loadApp({ adapterImpl: () => ({ text: 'ok' }) });

  await call(app, 'PUT', '/api/settings/ai', { enabled: false });
  await call(app, 'PUT', '/api/settings/ai/providers/groq', { enabled: true });
  await call(app, 'POST', '/api/settings/ai/providers/groq/clear-cooldown');

  assert.equal(saw.invalidated, 3,
    'a setting that needs a restart to take effect is the bug this replaces');
});

test('the saving admin is recorded', async () => {
  const { app, saw } = loadApp({ adapterImpl: () => ({ text: 'ok' }) });
  await call(app, 'PUT', '/api/settings/ai/providers/groq', { enabled: true });
  assert.equal(saw.upserts[0].updatedBy, 'admin');
});

test('an invalid provider is a 400 with the constraint quoted, not a 500', async () => {
  const { app } = loadApp({ adapterImpl: () => ({ text: 'ok' }) });
  const providers = require.cache[path.resolve(__dirname, '../database/aiProviders.js')].exports;
  providers.upsertProvider = async () => {
    throw new Error('new row violates check constraint "ai_providers_adapter_check"');
  };

  const res = await call(app, 'PUT', '/api/settings/ai/providers/nonsense', { adapter: 'telepathy' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /not valid/);
});
