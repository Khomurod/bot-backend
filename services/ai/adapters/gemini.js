/**
 * One call to Gemini's generateContent — the one wire format that genuinely
 * differs, and the one client that has never had a timeout.
 *
 * `services/geminiClient.js` passes no `signal` and reads no timeout option, so
 * a hung connection hangs the caller indefinitely. That is not theoretical: it
 * is reachable from interactive paths — dispatch parsing and pinned-context
 * extraction both wait on it while somebody watches a screen. Every call
 * through this adapter is bounded.
 *
 * Like the OpenAI adapter, it does ONE attempt against ONE model and holds no
 * policy. It preserves two Gemini-specific behaviours that were learned the
 * hard way and would be quietly lost in a naive unification:
 *
 *   `temperature` is NOT sent to a gemini-3 model, which rejects it outright.
 *
 *   An empty candidate is an ERROR, not an empty success. Gemini answers 200
 *   with no text when it stops on a safety or length finish reason, and handing
 *   a consumer '' would look exactly like a model that had nothing to say.
 */
const DEFAULT_TIMEOUT_MS = 60_000;
const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Gemini 3 rejects an explicit temperature; everything before it wants one. */
function withTemperature(model, generationConfig = {}) {
  if (/^gemini-3/i.test(String(model || ''))) return generationConfig;
  if (generationConfig.temperature !== undefined) return generationConfig;
  return { ...generationConfig, temperature: 0.1 };
}

function extractText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => p?.text || '').join('').trim();
}

async function callGeminiGenerate({
  apiKey, model, contents, systemInstruction = null, generationConfig = {},
  timeoutMs = DEFAULT_TIMEOUT_MS, baseUrl = API_ROOT,
} = {}) {
  if (!apiKey) {
    const err = new Error('No API key is configured for this provider');
    err.status = 401;
    throw err;
  }
  const body = {
    contents,
    generationConfig: withTemperature(model, generationConfig),
  };
  if (systemInstruction) body.systemInstruction = systemInstruction;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(
      `${String(baseUrl).replace(/\/+$/, '')}/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      }
    );
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      const timeout = new Error(`${model}: request timed out after ${timeoutMs}ms`);
      timeout.model = model;
      throw timeout;
    }
    err.model = model;
    throw err;
  }
  clearTimeout(timer);

  if (!response.ok) {
    let detail = '';
    try {
      const problem = await response.json();
      detail = problem?.error?.message || JSON.stringify(problem).slice(0, 300);
    } catch {
      detail = await response.text().catch(() => '');
    }
    const err = new Error(`${response.status} ${detail || response.statusText}`.trim());
    err.status = response.status;
    err.model = model;
    err.retryAfterHeader = response.headers?.get?.('retry-after') ?? null;
    throw err;
  }

  const payload = await response.json();
  const text = extractText(payload);
  if (!text) {
    // A 200 with no candidate text means it stopped for a reason. Say which.
    const finish = payload?.candidates?.[0]?.finishReason || 'no candidates';
    const err = new Error(`${model}: empty response (${finish})`);
    err.status = null;
    err.model = model;
    err.emptyResponse = true;
    throw err;
  }
  return {
    text,
    model,
    payload,
    usage: payload?.usageMetadata || null,
  };
}

module.exports = { callGeminiGenerate, withTemperature, extractText, DEFAULT_TIMEOUT_MS, API_ROOT };
