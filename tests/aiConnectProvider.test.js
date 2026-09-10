/**
 * Add a provider → paste key → Connect, end to end with a stubbed provider.
 *
 * The messages are asserted as words, because they ARE the feature: an operator
 * who reads "API key is invalid" fixes a different thing from one who reads
 * "reachable, but no compatible free models". Both used to be "could not tell
 * what went wrong".
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { connectProvider } = require('../services/ai/discovery/connectProvider');
const { refreshProviderModels } = require('../services/ai/discovery/refreshModels');
const { normaliseModel } = require('../lib/ai/modelSelection');

const openai = (id, extra = {}) => normaliseModel({ id, ...extra }, 'openai_chat');

function deps({
  models = [], listError = null, callImpl = async () => ({ text: 'ok' }), freeOnlyMode = false, existing = null,
} = {}) {
  const saw = { upserts: [], discovered: [], events: [], sources: [], invalidated: 0, calls: [] };
  return {
    saw,
    listModels: async () => { if (listError) throw listError; return models; },
    callOpenAiChat: async (args) => { saw.calls.push(args); return callImpl(args); },
    callGeminiGenerate: async (args) => { saw.calls.push(args); return callImpl(args); },
    aiProviders: {
      async getProviderSecretsByKey() { return existing; },
      async nextPriority() { return 30; },
      async upsertProvider(key, patch) { saw.upserts.push({ key, ...patch }); return { providerKey: key }; },
      async saveDiscoveredModels(key, payload) { saw.discovered.push({ key, ...payload }); },
    },
    aiSettings: { async getAiSettings() { return { freeOnlyMode }; } },
    aiPolicy: { async addSource(s) { saw.sources.push(s); return s; } },
    modelEvents: { async recordModelEvent(e) { saw.events.push(e); return e; } },
    invalidateRegistry() { saw.invalidated += 1; },
  };
}

const httpError = (status, message) => { const e = new Error(message); e.status = status; return e; };

test('OpenRouter: key pasted, everything else discovered — and the words say so', async () => {
  const d = deps({
    models: [
      openai('meta-llama/llama-3.3-70b-instruct:free', { pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } }),
      openai('google/gemma-3-27b-it:free', { pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } }),
      openai('openai/gpt-4o', { pricing: { prompt: '1', completion: '1' }, architecture: { output_modalities: ['text'] } }),
      openai('openai/whisper-1', { pricing: { prompt: '1', completion: '1' }, architecture: { output_modalities: ['text'] } }),
    ].map((m) => ({ ...m, providerKey: 'openrouter' })),
  });
  const r = await connectProvider({ catalogKey: 'openrouter', apiKey: 'sk-or-abc', updatedBy: 'admin' }, d);

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.providerKey, 'openrouter');
  assert.match(r.message, /OpenRouter connected successfully\./);
  assert.match(r.message, /3 compatible models found\./);
  assert.match(r.message, /2 free models currently available\./);
  assert.match(r.message, /Wenze selected 3 preferred models for fallback\./);

  const up = d.saw.upserts[0];
  assert.equal(up.baseUrl, 'https://openrouter.ai/api/v1', 'the operator never typed this');
  assert.equal(up.adapter, 'openai_chat');
  assert.equal(up.enabled, true);
  assert.equal(up.priority, 30, 'a new provider goes after the existing ones, not in front');
  assert.equal(up.catalogKey, 'openrouter');
  assert.equal(up.apiKey, 'sk-or-abc');
  assert.equal(up.modelChain.includes('openai/whisper-1'), false);
  assert.equal(d.saw.calls.length, 1, 'one cheap call proves the key');
  assert.equal(d.saw.calls[0].maxTokens, 8);
  assert.ok(d.saw.sources.length >= 2, 'the terms watcher is seeded with the official pages');
  assert.ok(d.saw.sources.every((s) => s.sourceOrigin === 'catalog' && s.providerKey === 'openrouter'));
  assert.ok(d.saw.events.some((e) => e.event === 'selected' && e.initiator === 'connect'));
  assert.equal(d.saw.invalidated, 1);
});

test('an existing provider keeps its priority when reconnected', async () => {
  const d = deps({ models: [openai('llama-3.1-8b-instant')], existing: { providerKey: 'groq', priority: 10 } });
  const r = await connectProvider({ catalogKey: 'groq', apiKey: 'gsk_x' }, d);
  assert.equal(r.ok, true);
  assert.equal('priority' in d.saw.upserts[0], false);
});

test('a rejected key says so, and hints when it is clearly another provider\'s key', async () => {
  const d = deps({ listError: httpError(401, 'Invalid API Key') });
  const r = await connectProvider({ catalogKey: 'groq', apiKey: 'sk-or-this-is-openrouter' }, d);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_key');
  assert.match(r.message, /^API key is invalid\./);
  assert.match(r.message, /does not look like a Groq key/);
  assert.equal(d.saw.upserts.length, 0, 'nothing is saved on a failed connect');
});

test('free-only mode with no free model is explained, not a shrug', async () => {
  const d = deps({
    freeOnlyMode: true,
    models: [openai('openai/gpt-4o', { pricing: { prompt: '1', completion: '1' }, architecture: { output_modalities: ['text'] } })]
      .map((m) => ({ ...m, providerKey: 'openrouter' })),
  });
  const r = await connectProvider({ catalogKey: 'openrouter', apiKey: 'sk-or-x' }, d);
  assert.equal(r.reason, 'no_free_models');
  assert.match(r.message, /reachable, but no compatible free models are currently available/);
});

test('a listing with no chat model at all is its own message', async () => {
  const d = deps({ models: [openai('text-embedding-3-small'), openai('whisper-1')] });
  const r = await connectProvider({ catalogKey: 'groq', apiKey: 'gsk_x' }, d);
  assert.equal(r.reason, 'no_compatible_models');
  assert.match(r.message, /none of its 2 models can answer a chat prompt/);
});

test('the smoke test drops a refused model and connects on the next one', async () => {
  const d = deps({
    models: [openai('llama-3.3-70b-versatile'), openai('llama-3.1-8b-instant')].map((m) => ({ ...m, providerKey: 'groq' })),
    callImpl: async ({ model }) => {
      if (model === 'llama-3.3-70b-versatile') throw httpError(404, 'model_not_found: decommissioned');
      return { text: 'ok' };
    },
  });
  const r = await connectProvider({ catalogKey: 'groq', apiKey: 'gsk_x' }, d);
  assert.equal(r.ok, true);
  assert.deepEqual(d.saw.upserts[0].modelChain, ['llama-3.1-8b-instant']);
  assert.equal(r.report.tested.model, 'llama-3.1-8b-instant');
  assert.ok(d.saw.events.some((e) => e.event === 'refused' && e.model === 'llama-3.3-70b-versatile'));
});

test('a spent allowance still connects — a 429 proves the key', async () => {
  const d = deps({
    models: [openai('llama-3.1-8b-instant')].map((m) => ({ ...m, providerKey: 'groq' })),
    callImpl: async () => { throw httpError(429, 'Rate limit reached: daily quota exceeded'); },
  });
  const r = await connectProvider({ catalogKey: 'groq', apiKey: 'gsk_x' }, d);
  assert.equal(r.ok, true);
  assert.match(r.message, /allowance is spent right now/);
});

test('a custom provider needs a Base URL, and only a Base URL', async () => {
  const none = await connectProvider({ catalogKey: 'custom', apiKey: 'k' }, deps());
  assert.equal(none.reason, 'missing_base_url');

  const d = deps({ models: [openai('my-chat-model')] });
  const r = await connectProvider({ catalogKey: 'custom', apiKey: 'k', baseUrl: 'https://llm.example.com/v1/' }, d);
  assert.equal(r.ok, true);
  assert.equal(r.providerKey, 'llm-example-com');
  assert.equal(d.saw.upserts[0].baseUrl, 'https://llm.example.com/v1');
  assert.equal(d.saw.upserts[0].catalogKey, 'custom');
  assert.equal(d.saw.sources.length, 0, 'nothing to seed the watcher with — Wenze knows nothing about this provider');
});

test('an unknown catalogue key is refused before any network call', async () => {
  const d = deps({ listError: new Error('should not be called') });
  const r = await connectProvider({ catalogKey: 'acme', apiKey: 'k' }, d);
  assert.equal(r.reason, 'unknown_provider');
});

// ─── refresh ─────────────────────────────────────────────────────────────────

test('refresh retires what the provider stopped listing and records every step', async () => {
  const d = deps({
    models: [openai('llama-3.3-70b-versatile'), openai('llama-3.1-8b-instant'), openai('openai/gpt-oss-20b')]
      .map((m) => ({ ...m, providerKey: 'groq' })),
    existing: { providerKey: 'groq', adapter: 'openai_chat', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk_x', modelChain: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'] },
  });
  const r = await refreshProviderModels('groq', { initiator: 'refresh' }, d);
  assert.equal(r.ok, true);
  assert.deepEqual(r.retired, ['mixtral-8x7b-32768']);
  assert.equal(r.changed, true);
  assert.equal(d.saw.upserts[0].modelChain.includes('mixtral-8x7b-32768'), false);
  const retired = d.saw.events.find((e) => e.event === 'retired');
  assert.equal(retired.model, 'mixtral-8x7b-32768');
  assert.equal(retired.initiator, 'refresh');
  assert.ok(d.saw.events.some((e) => e.event === 'selected'));
  assert.equal(d.saw.invalidated, 1);
});

test('a failed listing changes nothing and records the error', async () => {
  const d = deps({
    listError: httpError(503, 'Service Unavailable'),
    existing: { providerKey: 'groq', adapter: 'openai_chat', baseUrl: 'https://x', apiKey: 'k', modelChain: ['a', 'b'] },
  });
  const r = await refreshProviderModels('groq', {}, d);
  assert.equal(r.ok, false);
  assert.equal(d.saw.upserts.length, 0, 'one bad fetch must never strip a working chain');
  assert.match(d.saw.discovered[0].error, /Service Unavailable/, 'the admin can see WHY the listing is stale');
});

test('an unchanged listing writes no event', async () => {
  const d = deps({
    models: [openai('a'), openai('b')].map((m) => ({ ...m, providerKey: 'groq' })),
    existing: { providerKey: 'groq', adapter: 'openai_chat', baseUrl: 'https://x', apiKey: 'k', modelChain: ['a', 'b'] },
  });
  const r = await refreshProviderModels('groq', {}, d);
  assert.equal(r.changed, false);
  assert.equal(d.saw.events.length, 0);
  assert.equal(d.saw.upserts.length, 0);
});
