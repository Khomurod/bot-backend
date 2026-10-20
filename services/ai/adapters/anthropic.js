/**
 * One call to Anthropic's Messages API — Claude.
 *
 * Added October 2026 so an operator can put Claude anywhere in the provider
 * order (Settings → AI). It speaks through the official SDK rather than a
 * hand-rolled request, but holds to the same contract as the other two
 * adapters: ONE attempt against ONE model, no policy, and a failure that
 * carries `status`, the provider's own words and `retry-after` so
 * `lib/ai/classify.js` can tell a dead key from a busy minute. That is why the
 * SDK's own retries are switched off (`maxRetries: 0`): retrying, falling back
 * and cooling down belong to the router, and a client that quietly retried
 * twice would triple every wait the router measures.
 *
 * FOUR CLAUDE-SPECIFIC RULES, each one a 400 or a silent wrong answer if lost:
 *
 *   NO `temperature`. Current Claude models reject sampling parameters
 *   outright, the way gemini-3 rejects an explicit temperature.
 *
 *   `effort: 'low'` WHERE THE MODEL ACCEPTS IT. Every Wenze capability is a
 *   short classification or extraction, which low effort answers as well as
 *   high, faster and for fewer tokens. Older models (Sonnet/Haiku 4.5 and
 *   before) reject the field, so it is sent only to the families that take it.
 *
 *   A REFUSAL IS AN ERROR, not an empty success. Claude answers 200 with
 *   `stop_reason: 'refusal'` when it declines; handing a consumer '' would look
 *   like a model with nothing to say. Same for a reply with no text at all.
 *
 *   AN UNKNOWN MODEL SAYS "model not found". Anthropic answers a retired id
 *   with `404 not_found_error: "model: <id>"`, which the classifier would read
 *   as a request fault. Naming it lets the router skip just that model and the
 *   maintenance job confirm the retirement against the listing.
 */
const Anthropic = require('@anthropic-ai/sdk').default;

const DEFAULT_TIMEOUT_MS = 60_000;
const API_ROOT = 'https://api.anthropic.com';

/** Families that take `output_config.effort`; Sonnet/Haiku 4.5 and older do not. */
function acceptsEffort(model) {
  const id = String(model || '');
  if (/^claude-opus-4-5/i.test(id)) return true;
  return /^claude-(?:opus|sonnet|haiku|fable|mythos)-(?:[5-9]|4-[6-9])/i.test(id);
}

/**
 * The client, built per call — keys live in the database and change without a
 * restart. `fetch` is injected by tests only.
 */
function makeClient({
  apiKey, baseUrl = API_ROOT, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = null, workspaceId = null,
}) {
  return new Anthropic({
    apiKey,
    baseURL: String(baseUrl || API_ROOT).replace(/\/+$/, '').replace(/\/v1$/, ''),
    timeout: timeoutMs,
    maxRetries: 0,
    // An organization-level key is refused without it ("not scoped to a
    // workspace"); a workspace-scoped key needs none.
    ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

/** OpenAI-shaped messages → Anthropic's `system` string + user/assistant turns. */
function toAnthropicMessages(messages) {
  const system = [];
  const turns = [];
  for (const m of messages || []) {
    const text = String(m?.content ?? '');
    if (m?.role === 'system') system.push(text);
    else turns.push({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: text });
  }
  // The API wants a user turn first and will not take an empty conversation.
  if (!turns.length || turns[0].role !== 'user') turns.unshift({ role: 'user', content: '' });
  return { system: system.filter(Boolean).join('\n\n'), turns };
}

/** An SDK error → the shape every adapter throws. */
function normaliseError(err, model, timeoutMs) {
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    const timeout = new Error(`${model}: request timed out after ${timeoutMs}ms`);
    timeout.model = model;
    return timeout;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    // "network" is what the classifier reads as transient.
    const net = new Error(`${model}: network error — ${err.cause?.message || err.message}`);
    net.model = model;
    return net;
  }
  if (err instanceof Anthropic.APIError) {
    const body = err.error?.error || err.error || {};
    let detail = body.message || err.message;
    if (err.status === 404 && /^model:/i.test(String(body.message || ''))) {
      detail = `model not found (${body.message})`;
    }
    const out = new Error(`${err.status} ${detail}`.trim());
    out.status = err.status ?? null;
    out.model = model;
    out.retryAfterHeader = err.headers?.get?.('retry-after') ?? null;
    return out;
  }
  err.model = model;
  return err;
}

/**
 * @param {object} args
 * @param {string} args.apiKey
 * @param {string} args.model
 * @param {Array}  args.messages  OpenAI-shaped chat messages
 * @returns {Promise<{text: string, model: string, payload: object, usage: object|null}>}
 */
async function callAnthropicMessages({
  apiKey, model, messages, maxTokens = 2000,
  timeoutMs = DEFAULT_TIMEOUT_MS, baseUrl = API_ROOT, fetchImpl = null, workspaceId = null,
} = {}) {
  if (!apiKey) {
    const err = new Error('No API key is configured for this provider');
    err.status = 401;
    throw err;
  }
  const { system, turns } = toAnthropicMessages(messages);
  const body = { model, max_tokens: maxTokens, messages: turns };
  if (system) body.system = system;
  if (acceptsEffort(model)) body.output_config = { effort: 'low' };

  let payload;
  try {
    payload = await makeClient({ apiKey, baseUrl, timeoutMs, fetchImpl, workspaceId }).messages.create(body);
  } catch (err) {
    throw normaliseError(err, model, timeoutMs);
  }

  const text = (payload?.content || [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text || '')
    .join('')
    .trim();
  if (payload?.stop_reason === 'refusal' || !text) {
    const why = payload?.stop_reason === 'refusal'
      ? `refused (${payload?.stop_details?.category || 'no category'})`
      : `empty response (${payload?.stop_reason || 'no content'})`;
    const err = new Error(`${model}: ${why}`);
    err.status = null;
    err.model = model;
    err.emptyResponse = true;
    throw err;
  }
  const u = payload?.usage || null;
  return {
    text,
    model: payload?.model || model,
    payload,
    // In the OpenAI names the router's call log already reads.
    usage: u ? { ...u, prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens } : null,
  };
}

module.exports = {
  callAnthropicMessages, makeClient, toAnthropicMessages, acceptsEffort,
  DEFAULT_TIMEOUT_MS, API_ROOT,
};
