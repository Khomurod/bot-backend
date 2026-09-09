/**
 * One call to an OpenAI-compatible chat-completions endpoint.
 *
 * This one adapter covers Groq, Cerebras, Mistral, OpenRouter, Together and
 * most other free tiers, because `services/groqClient.js` was already speaking
 * this protocol — adding a provider is a `base_url` and a key in a database
 * row, not new code. That is the single biggest reason this layer is small.
 *
 * The adapter does ONE attempt against ONE model and either returns or throws.
 * It holds no opinion about retries, fallback or cooldowns: those are the
 * router's, informed by `lib/ai/classify.js`. Keeping the transport free of
 * policy is what makes both testable.
 *
 * What it does guarantee is that a failure carries enough for the classifier to
 * work with — `status`, the provider's own message, and the `retry-after`
 * header — because a thrown Error with only a string is the reason a router
 * ends up guessing.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * @param {object} args
 * @param {string} args.baseUrl   e.g. https://api.groq.com/openai/v1
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {Array}  args.messages  OpenAI chat messages
 * @returns {Promise<{text: string, model: string, payload: object, usage: object|null}>}
 */
async function callOpenAiChat({
  baseUrl, apiKey, model, messages,
  temperature = 0.2, maxTokens = 2000, responseFormat = null, seed = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!apiKey) {
    const err = new Error('No API key is configured for this provider');
    err.status = 401;
    throw err;
  }
  const url = `${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (responseFormat) body.response_format = responseFormat;
  if (seed !== null) body.seed = seed;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      // No status on purpose: the classifier reads the word "timeout" and calls
      // it transient, which is what a timeout is.
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
      detail = problem?.error?.message || problem?.message || JSON.stringify(problem).slice(0, 300);
    } catch {
      detail = await response.text().catch(() => '');
    }
    const err = new Error(`${response.status} ${detail || response.statusText}`.trim());
    err.status = response.status;
    err.model = model;
    // Handed on rather than parsed here: how long to wait is the router's call.
    err.retryAfterHeader = response.headers?.get?.('retry-after') ?? null;
    throw err;
  }

  const payload = await response.json();
  const text = String(payload?.choices?.[0]?.message?.content || '').trim();
  return {
    text,
    model: payload?.model || model,
    payload,
    usage: payload?.usage || null,
  };
}

module.exports = { callOpenAiChat, DEFAULT_TIMEOUT_MS };
