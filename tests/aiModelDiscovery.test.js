/**
 * Discovery reads the provider's own listing — the two wire shapes, paging,
 * and a failure that says WHICH thing failed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { listModels } = require('../services/ai/discovery/modelDiscovery');

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const hit = routes.find((r) => String(url).includes(r.match));
    if (!hit) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}), text: async () => '' };
    if (hit.status && hit.status >= 400) {
      return {
        ok: false, status: hit.status, statusText: 'x',
        json: async () => hit.body || { error: { message: hit.message || 'nope' } },
        text: async () => '',
      };
    }
    return { ok: true, status: 200, json: async () => hit.body };
  };
  return { impl, calls };
}

test('an OpenAI-compatible listing is normalised, with Bearer auth', async () => {
  const { impl, calls } = fakeFetch([{
    match: '/models',
    body: { data: [{ id: 'llama-3.1-8b-instant', owned_by: 'Meta', context_window: 131072 }] },
  }]);
  const models = await listModels({
    adapter: 'openai_chat', baseUrl: 'https://api.groq.com/openai/v1/', apiKey: 'gsk_x',
    providerKey: 'groq', fetchImpl: impl,
  });
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/models', 'trailing slash on the base is tolerated');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer gsk_x');
  assert.deepEqual(models.map((m) => m.id), ['llama-3.1-8b-instant']);
  assert.equal(models[0].contextLength, 131072);
  assert.equal(models[0].providerKey, 'groq');
});

test('Gemini pages through nextPageToken and strips the models/ prefix', async () => {
  const { impl, calls } = fakeFetch([
    {
      match: 'pageToken=p2',
      body: { models: [{ name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] }] },
    },
    {
      match: '/models',
      body: {
        models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576 }],
        nextPageToken: 'p2',
      },
    },
  ]);
  const models = await listModels({
    adapter: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'AIza', fetchImpl: impl,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'AIza');
  assert.deepEqual(models.map((m) => m.id), ['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  assert.equal(models[0].contextLength, 1048576);
});

test('a rejected key surfaces as status 401 with the provider\'s words', async () => {
  const { impl } = fakeFetch([{ match: '/models', status: 401, message: 'Invalid API Key' }]);
  await assert.rejects(
    () => listModels({ adapter: 'openai_chat', baseUrl: 'https://x/v1', apiKey: 'bad', fetchImpl: impl }),
    (err) => err.status === 401 && /Invalid API Key/.test(err.message),
  );
});

test('no key and no base URL fail before any request is made', async () => {
  const { impl, calls } = fakeFetch([]);
  await assert.rejects(() => listModels({ adapter: 'openai_chat', baseUrl: 'https://x/v1', apiKey: '', fetchImpl: impl }),
    (e) => e.status === 401);
  await assert.rejects(() => listModels({ adapter: 'openai_chat', baseUrl: '', apiKey: 'k', fetchImpl: impl }),
    (e) => e.status === 404);
  assert.equal(calls.length, 0);
});

test('a hung listing is bounded', async () => {
  const impl = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
  });
  await assert.rejects(
    () => listModels({ adapter: 'openai_chat', baseUrl: 'https://x/v1', apiKey: 'k', timeoutMs: 20, fetchImpl: impl }),
    /timed out/,
  );
});
