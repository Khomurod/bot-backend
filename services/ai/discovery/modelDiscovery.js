/**
 * Ask a provider which models exist, instead of remembering.
 *
 * Every provider in the catalogue exposes a models endpoint. Two wire shapes
 * cover all of them:
 *
 *   OpenAI-compatible  GET {baseUrl}/models  → { data: [{ id, owned_by, ... }] }
 *                      OpenRouter adds `pricing`, `context_length` and
 *                      `architecture`; Groq adds `context_window`. Whatever is
 *                      there is kept; nothing is required beyond `id`.
 *
 *   Gemini             GET {baseUrl}/models  → { models: [{ name, displayName,
 *                      supportedGenerationMethods, inputTokenLimit }],
 *                      nextPageToken? } — paged, and honest about what each
 *                      model can do, which selection prefers over its name.
 *
 * ONE ATTEMPT, NO POLICY. Like the call adapters, this throws an Error carrying
 * `status` and the provider's own message so the caller can say "the key is
 * invalid" (401/403) rather than "could not tell what went wrong". Timeouts are
 * bounded — a discovery that hangs would hang the Connect button.
 *
 * `fetchImpl` is injected for tests. Production callers never pass it.
 */
const { normaliseModel } = require('../../../lib/ai/modelSelection');

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_PAGES = 10;

async function fetchJson(url, { headers, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      const timeout = new Error(`models listing timed out after ${timeoutMs}ms`);
      timeout.status = null;
      throw timeout;
    }
    throw err;
  }
  clearTimeout(timer);

  if (!response.ok) {
    let detail = '';
    try {
      const problem = await response.json();
      detail = problem?.error?.message || problem?.message || JSON.stringify(problem).slice(0, 300);
    } catch {
      detail = await response.text().catch(() => '');
    }
    const err = new Error(`${response.status} ${detail || response.statusText}`.trim());
    err.status = response.status;
    throw err;
  }
  return response.json();
}

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

async function listOpenAiModels({ baseUrl, apiKey, timeoutMs, fetchImpl, providerKey }) {
  const payload = await fetchJson(`${trimSlash(baseUrl)}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    timeoutMs, fetchImpl,
  });
  const rows = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);
  return rows.filter((r) => r && (r.id || r.name)).map((r) => normaliseModel(r, 'openai_chat', providerKey));
}

async function listGeminiModels({ baseUrl, apiKey, timeoutMs, fetchImpl, providerKey }) {
  const out = [];
  let pageToken = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`${trimSlash(baseUrl)}/models`);
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const payload = await fetchJson(url.toString(), {
      headers: { 'x-goog-api-key': apiKey, Accept: 'application/json' },
      timeoutMs, fetchImpl,
    });
    for (const m of (Array.isArray(payload?.models) ? payload.models : [])) {
      out.push(normaliseModel(m, 'gemini', providerKey));
    }
    pageToken = payload?.nextPageToken || null;
    if (!pageToken) break;
  }
  return out;
}

/**
 * @returns {Promise<Array>} normalised models — see lib/ai/modelSelection.normaliseModel
 * @throws Error with `.status` (401/403 = the key; 404 = no such endpoint; null = network/timeout)
 */
async function listModels({
  adapter, baseUrl, apiKey, providerKey = null,
  timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) {
    const err = new Error('No API key to list models with');
    err.status = 401;
    throw err;
  }
  if (!baseUrl) {
    const err = new Error('No Base URL to list models from');
    err.status = 404;
    throw err;
  }
  const args = { baseUrl, apiKey, timeoutMs, fetchImpl, providerKey };
  return adapter === 'gemini' ? listGeminiModels(args) : listOpenAiModels(args);
}

module.exports = { listModels, DEFAULT_TIMEOUT_MS, MAX_PAGES };
