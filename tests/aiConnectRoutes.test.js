/**
 * The three routes behind "pick a provider, paste the key, Connect".
 *
 * The catalogue read is public facts and must never carry a key; the connect
 * route hands the body to the service and returns its plain-language result
 * as a 200 whether or not the provider accepted — the request succeeded, and
 * what failed (if anything) is the thing being connected.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const ROUTE = path.resolve(__dirname, '../server/routes/settings/aiRoutes.js');
const stub = (rel, exports) => { require.cache[path.resolve(__dirname, rel)] = { exports }; };

function loadApp({ connectImpl, refreshImpl, configured = ['groq', 'gemini'] } = {}) {
  delete require.cache[ROUTE];
  const saw = { connect: [], refresh: [] };
  stub('../database/aiSettings.js', {
    async getAiSettings() { return {}; }, async listCapabilities() { return []; },
    async updateAiSettings() { return {}; }, async updateCapability() { return {}; }, invalidateCache() {}, DEFAULTS: {},
  });
  stub('../database/aiProviders.js', {
    async listProvidersForAdmin() { return configured.map((k) => ({ providerKey: k })); },
    async getProvidersForRouter() { return []; },
    async upsertProvider() { return {}; }, async deleteProvider() { return true; }, async clearCooldown() { return {}; },
  });
  stub('../database/aiCallLog.js', { async summariseProviderHealth() { return []; }, async listRecentFailures() { return []; } });
  stub('../database/aiModelEvents.js', {
    async listModelEvents() { return [{ providerKey: 'groq', event: 'retired', model: 'old' }]; },
  });
  stub('../services/ai/registry.js', { invalidateRegistry() {}, getRoster: async () => ({}) });
  stub('../services/ai/adapters/openaiChat.js', { callOpenAiChat: async () => ({ text: 'ok' }), DEFAULT_TIMEOUT_MS: 1 });
  stub('../services/ai/adapters/gemini.js', { callGeminiGenerate: async () => ({ text: 'ok' }), DEFAULT_TIMEOUT_MS: 1 });
  stub('../services/ai/discovery/connectProvider.js', {
    async connectProvider(args) { saw.connect.push(args); return connectImpl(args); },
  });
  stub('../services/ai/discovery/refreshModels.js', {
    async refreshProviderModels(key, opts) { saw.refresh.push({ key, ...opts }); return refreshImpl(key, opts); },
  });

  const { createAiSettingsRouter } = require(ROUTE);
  const app = express();
  app.use(express.json());
  app.use('/api/settings', createAiSettingsRouter({
    authMiddleware: (req, _res, next) => { req.admin = { username: 'tom' }; next(); },
  }));
  return { app, saw };
}

async function call(app, method, url, body) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { server.close(); }
}

test('the catalogue lists every known provider plus custom, says which are configured, and carries no secret', async () => {
  const { app } = loadApp();
  const res = await call(app, 'GET', '/api/settings/ai/catalog');
  assert.equal(res.status, 200);
  const keys = res.body.catalog.map((c) => c.key);
  assert.ok(keys.includes('openrouter') && keys.includes('cerebras') && keys.includes('nvidia'));
  assert.equal(keys[keys.length - 1], 'custom');
  assert.equal(res.body.catalog.find((c) => c.key === 'groq').configured, true);
  assert.equal(res.body.catalog.find((c) => c.key === 'openrouter').configured, false);
  assert.equal(res.body.catalog.find((c) => c.key === 'custom').needsBaseUrl, true);
  assert.equal(JSON.stringify(res.body).toLowerCase().includes('apikey'), false);
});

test('connect passes the body and the admin through, and returns the service\'s words as a 200', async () => {
  const { app, saw } = loadApp({
    connectImpl: async () => ({ ok: false, reason: 'invalid_key', message: 'API key is invalid.' }),
  });
  const res = await call(app, 'POST', '/api/settings/ai/providers/connect', { catalogKey: 'openrouter', apiKey: 'sk-or-x' });
  assert.equal(res.status, 200, 'a rejected key is not a server fault');
  assert.equal(res.body.reason, 'invalid_key');
  assert.equal(saw.connect[0].catalogKey, 'openrouter');
  assert.equal(saw.connect[0].apiKey, 'sk-or-x');
  assert.equal(saw.connect[0].updatedBy, 'tom');
});

test('connect without a catalogue key is a 400', async () => {
  const { app, saw } = loadApp({ connectImpl: async () => ({ ok: true }) });
  const res = await call(app, 'POST', '/api/settings/ai/providers/connect', { apiKey: 'x' });
  assert.equal(res.status, 400);
  assert.equal(saw.connect.length, 0);
});

test('refresh-models is a manual refresh attributed to the admin', async () => {
  const { app, saw } = loadApp({ refreshImpl: async () => ({ ok: true, retired: ['old'], changed: true }) });
  const res = await call(app, 'POST', '/api/settings/ai/providers/groq/refresh-models');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.retired, ['old']);
  assert.equal(saw.refresh[0].key, 'groq');
  assert.equal(saw.refresh[0].initiator, 'manual');
  assert.equal(saw.refresh[0].updatedBy, 'tom');
});

test('the tab payload now carries the model events', async () => {
  const { app } = loadApp();
  const res = await call(app, 'GET', '/api/settings/ai');
  assert.equal(res.body.modelEvents[0].event, 'retired');
});
