'use strict';

/**
 * Claude as a provider (owner, October 2026): the Anthropic adapter and its
 * model listing, against a fake `fetch` — no network, no key.
 *
 * Pinned here: the adapter makes ONE attempt (the router owns retries), every
 * failure reaches the classifier as the right KIND, a refusal or an empty reply
 * is never handed on as an answer, and no parameter a current Claude model
 * rejects is ever sent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  callAnthropicMessages, acceptsEffort, toAnthropicMessages,
} = require('../services/ai/adapters/anthropic');
const { listModels } = require('../services/ai/discovery/modelDiscovery');
const { classifyFailure, FAILURE } = require('../lib/ai/classify');

function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return new Response(JSON.stringify(next.body), {
      status: next.status || 200,
      headers: { 'content-type': 'application/json', ...(next.headers || {}) },
    });
  };
  return { impl, calls };
}

const message = (over = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
  content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn',
  usage: { input_tokens: 12, output_tokens: 4 }, ...over,
});
const apiError = (type, text) => ({ type: 'error', error: { type, message: text } });

async function failureOf(args) {
  try {
    await callAnthropicMessages({ apiKey: 'k', model: 'claude-x', messages: [{ role: 'user', content: 'q' }], ...args });
  } catch (err) {
    return { err, kind: classifyFailure({ status: err.status ?? null, message: err.message }).kind };
  }
  throw new Error('expected a failure');
}

test('one call: system text split out, low effort, no temperature, key in x-api-key', async () => {
  const { impl, calls } = fakeFetch([{ body: message() }]);
  const out = await callAnthropicMessages({
    apiKey: 'sk-ant-test', model: 'claude-haiku-5-5', fetchImpl: impl, maxTokens: 300,
    messages: [{ role: 'system', content: 'Answer in JSON.' }, { role: 'user', content: 'Is this a quit?' }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(new Headers(calls[0].init.headers).get('x-api-key'), 'sk-ant-test');
  assert.ok(new Headers(calls[0].init.headers).get('anthropic-version'));
  assert.deepEqual(calls[0].body, {
    model: 'claude-haiku-5-5', max_tokens: 300, system: 'Answer in JSON.',
    messages: [{ role: 'user', content: 'Is this a quit?' }],
    output_config: { effort: 'low' },
  });
  assert.equal(out.text, '{"ok":true}');
  assert.equal(out.usage.prompt_tokens, 12, 'the call log reads OpenAI names');
  assert.equal(out.usage.completion_tokens, 4);
});

test('effort is sent only to the families that accept it', () => {
  for (const id of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1',
    'claude-sonnet-4-6', 'claude-opus-4-8', 'claude-opus-4-5']) {
    assert.equal(acceptsEffort(id), true, id);
  }
  for (const id of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-3-5-haiku-latest', 'claude-x', '']) {
    assert.equal(acceptsEffort(id), false, id);
  }
});

test('a conversation always opens with a user turn', () => {
  assert.deepEqual(toAnthropicMessages([{ role: 'system', content: 'S' }]).turns, [{ role: 'user', content: '' }]);
  const { turns } = toAnthropicMessages([{ role: 'assistant', content: 'a' }, { role: 'user', content: 'u' }]);
  assert.equal(turns[0].role, 'user');
});

test('A BUSY ANTHROPIC IS ASKED ONCE — the router, not the SDK, decides what next', async () => {
  const { impl, calls } = fakeFetch([{ status: 529, body: apiError('overloaded_error', 'Overloaded') }]);
  const { err, kind } = await failureOf({ fetchImpl: impl });
  assert.equal(calls.length, 1, 'SDK retries would multiply every wait the router measures');
  assert.equal(err.status, 529);
  assert.equal(kind, FAILURE.TRANSIENT);
});

test('every failure reaches the classifier as the right kind', async () => {
  const cases = [
    [{ status: 429, body: apiError('rate_limit_error', 'Rate limited'), headers: { 'retry-after': '7' } }, FAILURE.TRANSIENT],
    [{ status: 401, body: apiError('authentication_error', 'invalid x-api-key') }, FAILURE.CREDENTIAL],
    [{ status: 404, body: apiError('not_found_error', 'model: claude-gone') }, FAILURE.MODEL],
    [{ status: 400, body: apiError('invalid_request_error',
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.') },
    FAILURE.QUOTA],
  ];
  for (const [response, expected] of cases) {
    const { impl } = fakeFetch([response]);
    const { err, kind } = await failureOf({ fetchImpl: impl });
    assert.equal(kind, expected, `${response.status} → ${expected}`);
    assert.equal(err.status, response.status);
  }
  const { impl } = fakeFetch([{ status: 429, body: apiError('rate_limit_error', 'x'), headers: { 'retry-after': '7' } }]);
  assert.equal((await failureOf({ fetchImpl: impl })).err.retryAfterHeader, '7');
});

test('A REFUSAL OR AN EMPTY REPLY IS AN ERROR, never an answer', async () => {
  const refusal = fakeFetch([{ body: message({ content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' } }) }]);
  assert.match((await failureOf({ fetchImpl: refusal.impl })).err.message, /refused \(cyber\)/);
  const empty = fakeFetch([{ body: message({ content: [{ type: 'thinking', thinking: '' }], stop_reason: 'max_tokens' }) }]);
  assert.match((await failureOf({ fetchImpl: empty.impl })).err.message, /empty response \(max_tokens\)/);
});

test('a hung call is bounded and reads as transient; no key fails before any request', async () => {
  const hang = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const { err, kind } = await failureOf({ fetchImpl: hang, timeoutMs: 30 });
  assert.match(err.message, /timed out after 30ms/);
  assert.equal(kind, FAILURE.TRANSIENT);

  const { impl, calls } = fakeFetch([{ body: message() }]);
  await assert.rejects(
    callAnthropicMessages({ apiKey: '', model: 'm', messages: [], fetchImpl: impl }),
    (e) => e.status === 401
  );
  assert.equal(calls.length, 0);
});

test('Claude\'s models are listed through /v1/models, every page of them', async () => {
  const { impl, calls } = fakeFetch([
    { body: { data: [{ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', max_input_tokens: 1000000, type: 'model' }], has_more: true, first_id: 'claude-haiku-5-5', last_id: 'claude-haiku-5-5' } },
    { body: { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1000000, type: 'model' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' } },
  ]);
  const models = await listModels({
    adapter: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k', providerKey: 'anthropic', fetchImpl: impl,
  });
  assert.deepEqual(models.map((m) => m.id), ['claude-haiku-5-5', 'claude-opus-5-5']);
  assert.equal(models[0].displayName, 'Claude Haiku 5.5');
  assert.equal(models[0].contextLength, 1000000);
  assert.match(calls[0].url, /\/v1\/models/);
  assert.match(calls[1].url, /after_id=claude-haiku-5-5/);
});

test('a rejected key on the listing says 401, so Connect can say "the key is invalid"', async () => {
  const { impl } = fakeFetch([{ status: 401, body: apiError('authentication_error', 'invalid x-api-key') }]);
  await assert.rejects(
    listModels({ adapter: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'bad', fetchImpl: impl }),
    (err) => err.status === 401 && /invalid x-api-key/.test(err.message)
  );
});

test('AN ORGANIZATION-LEVEL KEY WORKS: the workspace id travels as anthropic-workspace-id', async () => {
  const { impl, calls } = fakeFetch([{ body: message() }]);
  await callAnthropicMessages({
    apiKey: 'sk-ant-org', model: 'claude-haiku-5-5', fetchImpl: impl, workspaceId: 'wrkspc_01ABC',
    messages: [{ role: 'user', content: 'q' }],
  });
  assert.equal(new Headers(calls[0].init.headers).get('anthropic-workspace-id'), 'wrkspc_01ABC');

  const plain = fakeFetch([{ body: message() }]);
  await callAnthropicMessages({ apiKey: 'k', model: 'claude-haiku-5-5', fetchImpl: plain.impl, messages: [{ role: 'user', content: 'q' }] });
  assert.equal(new Headers(plain.calls[0].init.headers).get('anthropic-workspace-id'), null, 'no id, no header');

  const listing = fakeFetch([{ body: { data: [{ id: 'claude-haiku-5-5', type: 'model' }], has_more: false } }]);
  await listModels({
    adapter: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k', fetchImpl: listing.impl, workspaceId: 'wrkspc_01ABC',
  });
  assert.equal(new Headers(listing.calls[0].init.headers).get('anthropic-workspace-id'), 'wrkspc_01ABC');
});
