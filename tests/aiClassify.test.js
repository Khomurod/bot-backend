/**
 * Classifying a provider's "no". PURE — no database, no network.
 *
 * These are the decisions the router is built on, and each test below is a
 * failure mode rather than a code path:
 *
 *   Classifying a spent free tier as "busy" means Wenze spends the rest of the
 *   day retrying a provider that already said no.
 *
 *   Classifying a bad model name as an unwell provider means one stale entry in
 *   a chain takes a healthy provider offline.
 *
 *   Aborting the whole chain on a 401 — which is what `groqClient` does today —
 *   turns one expired credential into a total AI outage the moment there is
 *   more than one provider.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FAILURE, classifyFailure, invalidResponse, retryAfterMs,
} = require('../lib/ai/classify');

// ─── the ordering argument ───────────────────────────────────────────────────

test('a spent free tier is quota, not "busy" — even though it arrives as a 429', () => {
  const verdict = classifyFailure({
    status: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.',
  });

  assert.equal(verdict.kind, FAILURE.QUOTA);
  assert.equal(verdict.retryable, false,
    'retrying inside the window is pure waste, and on a free tier it is hundreds of wasted calls');
  assert.equal(verdict.coolProvider, true);
});

test('a plain 429 with no quota language IS busy', () => {
  const verdict = classifyFailure({ status: 429, message: 'Rate limit reached. Try again in 1.5s' });

  assert.equal(verdict.kind, FAILURE.TRANSIENT);
  assert.equal(verdict.retryable, true);
});

test("Gemini's RESOURCE_EXHAUSTED is quota", () => {
  const verdict = classifyFailure({ status: 429, message: '429 RESOURCE_EXHAUSTED: daily limit' });
  assert.equal(verdict.kind, FAILURE.QUOTA);
});

test('a 403 mentioning quota is still a credential problem, because a person fixes it', () => {
  const verdict = classifyFailure({ status: 403, message: 'Billing quota not enabled for this key' });

  assert.equal(verdict.kind, FAILURE.CREDENTIAL,
    'a clock does not fix this one; an administrator does');
});

// ─── the defect this replaces ────────────────────────────────────────────────

test('a dead key stops THIS provider and never the run', () => {
  for (const failure of [
    { status: 401, message: 'Unauthorized' },
    { status: 403, message: 'Forbidden' },
    { status: null, message: 'Invalid API key provided' },
    { status: null, message: 'GROQ_API_KEY is not configured' },
  ]) {
    const verdict = classifyFailure(failure);
    assert.equal(verdict.kind, FAILURE.CREDENTIAL, failure.message);
    assert.equal(verdict.retryable, false, 'no amount of waiting fixes a dead key');
    assert.equal(verdict.nextProvider, true,
      'a dead key on provider A says NOTHING about provider B — aborting here is the bug');
    assert.equal(verdict.coolProvider, true, 'stop asking until a human touches it');
  }
});

// ─── the class that must not cool a provider ─────────────────────────────────

test('a bad request is our fault, so the provider is left healthy', () => {
  for (const status of [400, 404, 422]) {
    const verdict = classifyFailure({ status, message: 'model `llama-x` does not exist' });
    assert.equal(verdict.kind, FAILURE.FATAL_REQUEST, `status ${status}`);
    assert.equal(verdict.nextProvider, true);
    assert.equal(verdict.coolProvider, false,
      'one stale model name in a chain must not disable a working provider');
  }
});

test('an unrecognised failure moves on without punishing anyone', () => {
  const verdict = classifyFailure({ status: 418, message: 'something nobody has seen yet' });

  assert.equal(verdict.kind, FAILURE.UNKNOWN);
  assert.equal(verdict.nextProvider, true);
  assert.equal(verdict.coolProvider, false,
    'a message this function has not been taught is not evidence of an unwell provider');
});

// ─── transient, in all the shapes it really arrives in ───────────────────────

test('server errors, timeouts and socket failures are all transient', () => {
  const cases = [
    { status: 500, message: 'Internal Server Error' },
    { status: 503, message: 'Service Unavailable' },
    { status: 504, message: 'Gateway Timeout' },
    { status: null, message: 'Groq API timeout after 60000ms' },
    { status: null, message: 'fetch failed', code: 'ECONNRESET' },
    { status: null, message: '', code: 'ETIMEDOUT' },
    { status: null, message: 'The model is overloaded. Please try again later.' },
    { status: null, message: 'Gemini is experiencing high demand' },
  ];
  for (const failure of cases) {
    const verdict = classifyFailure(failure);
    assert.equal(verdict.kind, FAILURE.TRANSIENT, `${failure.status} ${failure.message} ${failure.code}`);
    assert.equal(verdict.retryable, true);
  }
});

test('a timeout is transient even though it carries no status at all', () => {
  // groqClient throws exactly this string, with no `.status` attached.
  const verdict = classifyFailure({ status: null, message: 'Groq API timeout after 60000ms' });
  assert.equal(verdict.kind, FAILURE.TRANSIENT);
});

// ─── a response that arrived and cannot be used ──────────────────────────────

test('unusable output is a provider failure, not something to hand a consumer', () => {
  const verdict = invalidResponse('JSON did not parse');

  assert.equal(verdict.kind, FAILURE.INVALID_RESPONSE);
  assert.equal(verdict.nextProvider, true,
    'free models differ widely in honouring a JSON instruction; try the next one');
  assert.equal(verdict.coolProvider, false,
    'a model that answered badly once is not unwell');
  assert.match(verdict.reason, /JSON/);
});

// ─── how long to wait ────────────────────────────────────────────────────────

test('retry-after is read from the header first', () => {
  assert.equal(retryAfterMs({ headerValue: '2' }), 2000);
  assert.equal(retryAfterMs({ headerValue: '0.5' }), 500);
});

test("...then from the body, in both providers' wordings", () => {
  // Groq's phrasing and Gemini's differ; both are parsed.
  assert.equal(retryAfterMs({ message: 'Rate limit reached. Try again in 1.5s' }), 1500);
  assert.equal(retryAfterMs({ message: 'Please retry in 4s' }), 4000);
  assert.equal(retryAfterMs({ message: 'try again in 250ms' }), 250);
});

test('a provider cannot ask Wenze to sleep for an hour', () => {
  assert.equal(retryAfterMs({ headerValue: '3600', maxMs: 35000 }), 35000);
  assert.equal(retryAfterMs({ message: 'try again in 900s', maxMs: 8000 }), 8000);
});

test('no stated delay is zero, not a guess', () => {
  assert.equal(retryAfterMs({ message: 'Service Unavailable' }), 0);
  assert.equal(retryAfterMs({}), 0);
  assert.equal(retryAfterMs({ headerValue: 'not-a-number' }), 0);
});

// ─── nothing today's clients detect may be lost ──────────────────────────────

test('everything the existing Groq client calls a rate limit still is', () => {
  // isGroqRateLimitError: 429, 503, >=500, /rate limit/, /too many requests/,
  // /service unavailable/, /try again/
  const groqCases = [
    { status: 429, message: '' }, { status: 503, message: '' }, { status: 502, message: '' },
    { status: null, message: 'rate limit exceeded for requests' },
    { status: null, message: 'Too Many Requests' },
    { status: null, message: 'Service unavailable' },
    { status: null, message: 'please try again shortly' },
  ];
  for (const failure of groqCases) {
    const verdict = classifyFailure(failure);
    assert.ok(
      verdict.kind === FAILURE.TRANSIENT || verdict.kind === FAILURE.QUOTA,
      `${failure.status} ${failure.message} became ${verdict.kind}`
    );
  }
});
