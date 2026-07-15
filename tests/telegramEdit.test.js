/**
 * Unit tests for the canonical Telegram edit error model + bounded retry
 * (services/telegramEdit.js). No network, no real sleeping — the retry wrapper
 * takes an injected `sleep` and `random`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyTelegramError,
  runTelegramEditWithRetry,
  sanitizeDescription,
} = require('../services/telegramEdit');

// ── Error builders ───────────────────────────────────────────────────────────
const transport = (code, message) => Object.assign(new Error(message || code), { code });
const nestedTransport = (code, message) => Object.assign(new Error(message || 'request failed'), { cause: { code } });
const socketHangUp = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
const apiError = (error_code, description, parameters) => Object.assign(new Error(description || `HTTP ${error_code}`), {
  response: { error_code, description, ...(parameters ? { parameters } : {}) },
});

const noSleep = async () => {};
const zeroRandom = () => 0;

// ── Classifier ───────────────────────────────────────────────────────────────

test('classify: "socket hang up" → retryable, ambiguous connection reset (not generic failed)', () => {
  const c = classifyTelegramError(socketHangUp(), { operation: 'edit_media_text_to_photo' });
  assert.equal(c.code, 'TELEGRAM_CONNECTION_RESET');
  assert.equal(c.category, 'transport');
  assert.equal(c.retryable, true);
  assert.equal(c.ambiguousOutcome, true);
  assert.equal(c.transportCode, 'ECONNRESET');
  assert.equal(c.operation, 'edit_media_text_to_photo');
});

test('classify: ECONNRESET via err.code only', () => {
  const c = classifyTelegramError(transport('ECONNRESET'));
  assert.equal(c.code, 'TELEGRAM_CONNECTION_RESET');
  assert.equal(c.retryable, true);
});

test('classify: ECONNRESET via err.cause.code (nested)', () => {
  const c = classifyTelegramError(nestedTransport('ECONNRESET', 'fetch failed'));
  assert.equal(c.code, 'TELEGRAM_CONNECTION_RESET');
  assert.equal(c.transportCode, 'ECONNRESET');
});

test('classify: ETIMEDOUT → timeout, retryable, ambiguous', () => {
  const c = classifyTelegramError(transport('ETIMEDOUT'));
  assert.equal(c.code, 'TELEGRAM_TIMEOUT');
  assert.equal(c.ambiguousOutcome, true);
});

test('classify: ECONNREFUSED / DNS are retryable but NOT ambiguous (never reached Telegram)', () => {
  assert.equal(classifyTelegramError(transport('ECONNREFUSED')).code, 'TELEGRAM_NETWORK_UNREACHABLE');
  assert.equal(classifyTelegramError(transport('ECONNREFUSED')).ambiguousOutcome, false);
  const dns = classifyTelegramError(transport('EAI_AGAIN'));
  assert.equal(dns.code, 'TELEGRAM_DNS_FAILURE');
  assert.equal(dns.ambiguousOutcome, false);
  assert.equal(dns.retryable, true);
});

test('classify: Telegram 429 carries retry_after and is retryable', () => {
  const c = classifyTelegramError(apiError(429, 'Too Many Requests', { retry_after: 7 }));
  assert.equal(c.code, 'TELEGRAM_RATE_LIMITED');
  assert.equal(c.category, 'rate_limit');
  assert.equal(c.retryable, true);
  assert.equal(c.retryAfterSeconds, 7);
});

test('classify: Telegram 5xx is retryable, 400/403 and message-state are not', () => {
  assert.equal(classifyTelegramError(apiError(500, 'Internal')).code, 'TELEGRAM_SERVICE_ERROR');
  assert.equal(classifyTelegramError(apiError(500, 'Internal')).retryable, true);
  assert.equal(classifyTelegramError(apiError(400, 'Bad Request: MEDIA_INVALID')).code, 'TELEGRAM_EDIT_REJECTED');
  assert.equal(classifyTelegramError(apiError(400, 'x')).retryable, false);
  assert.equal(classifyTelegramError(apiError(403, 'Forbidden')).code, 'BOT_PERMISSION');
  assert.equal(classifyTelegramError(apiError(400, 'Bad Request: message to edit not found')).code, 'MESSAGE_NOT_FOUND');
  assert.equal(classifyTelegramError(apiError(400, "Bad Request: message can't be edited")).code, 'MESSAGE_NOT_EDITABLE');
  assert.equal(classifyTelegramError(apiError(400, 'Bad Request: message is not modified')).code, 'NOT_MODIFIED');
});

test('sanitizeDescription strips URLs and bot tokens', () => {
  const err = new Error('failed https://api.telegram.org/bot123456:AAHsecretToken/editMessageMedia');
  const s = sanitizeDescription(err);
  assert.doesNotMatch(s, /AAHsecretToken/);
  assert.doesNotMatch(s, /api\.telegram\.org/);
  assert.match(s, /\[url\]/);
});

// ── Retry wrapper ────────────────────────────────────────────────────────────

test('retry: socket hang up on attempt 1, success on retry', async () => {
  let calls = 0;
  const r = await runTelegramEditWithRetry(async () => {
    calls += 1;
    if (calls === 1) throw socketHangUp();
    return { message_id: 1410 };
  }, { sleep: noSleep, random: zeroRandom });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.equal(calls, 2);
});

test('retry: ECONNRESET via cause.code, success second', async () => {
  let calls = 0;
  const r = await runTelegramEditWithRetry(async () => {
    calls += 1;
    if (calls === 1) throw nestedTransport('ECONNRESET');
    return { ok: true };
  }, { sleep: noSleep, random: zeroRandom });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
});

test('retry: lost response then "message is not modified" → SUCCESS (edit had applied)', async () => {
  let calls = 0;
  const r = await runTelegramEditWithRetry(async () => {
    calls += 1;
    if (calls === 1) throw socketHangUp();
    throw apiError(400, 'Bad Request: message is not modified');
  }, { sleep: noSleep, random: zeroRandom });
  assert.equal(r.ok, true);
  assert.equal(r.notModified, true);
  assert.equal(r.attempts, 2);
});

test('retry: three connection resets → NOT ok, reported as ambiguous/unconfirmed', async () => {
  let calls = 0;
  const r = await runTelegramEditWithRetry(async () => { calls += 1; throw socketHangUp(); },
    { sleep: noSleep, random: zeroRandom });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 3);
  assert.equal(calls, 3);
  assert.equal(r.classification.code, 'TELEGRAM_CONNECTION_RESET');
  assert.equal(r.classification.ambiguousOutcome, true);
});

test('retry: timeout then success', async () => {
  let calls = 0;
  const r = await runTelegramEditWithRetry(async () => {
    calls += 1;
    if (calls === 1) throw transport('ETIMEDOUT');
    return {};
  }, { sleep: noSleep, random: zeroRandom });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
});

test('retry: Telegram 500 then success', async () => {
  let calls = 0;
  const r = await runTelegramEditWithRetry(async () => {
    calls += 1;
    if (calls === 1) throw apiError(502, 'Bad Gateway');
    return {};
  }, { sleep: noSleep, random: zeroRandom });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
});

test('retry: 429 honours retry_after (capped) for the backoff delay', async () => {
  const slept = [];
  let calls = 0;
  const r = await runTelegramEditWithRetry(async () => {
    calls += 1;
    if (calls === 1) throw apiError(429, 'Too Many Requests', { retry_after: 5 });
    return {};
  }, { sleep: async (ms) => { slept.push(ms); }, random: zeroRandom });
  assert.equal(r.ok, true);
  assert.equal(slept.length, 1);
  assert.ok(slept[0] >= 5000, `waited at least retry_after (got ${slept[0]}ms)`);
});

test('retry: 429 retry_after is capped so a hostile value cannot wedge the request', async () => {
  const slept = [];
  await runTelegramEditWithRetry(async () => { throw apiError(429, 'x', { retry_after: 9999 }); },
    { sleep: async (ms) => { slept.push(ms); }, random: zeroRandom, retryAfterCapSeconds: 30 });
  for (const ms of slept) assert.ok(ms <= 30 * 1000 + 250, `capped (${ms}ms)`);
});

test('retry: Telegram 400 is NOT retried', async () => {
  let calls = 0;
  const r = await runTelegramEditWithRetry(async () => { calls += 1; throw apiError(400, 'Bad Request: bad'); },
    { sleep: noSleep, random: zeroRandom });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 1);
  assert.equal(calls, 1);
  assert.equal(r.classification.code, 'TELEGRAM_EDIT_REJECTED');
});

test('retry: Telegram 403 is NOT retried', async () => {
  let calls = 0;
  const r = await runTelegramEditWithRetry(async () => { calls += 1; throw apiError(403, 'Forbidden'); },
    { sleep: noSleep, random: zeroRandom });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 1);
  assert.equal(r.classification.code, 'BOT_PERMISSION');
});

test('retry: a per-attempt timeout is enforced and classified as an (ambiguous) timeout', async () => {
  let calls = 0;
  const r = await runTelegramEditWithRetry(async () => {
    calls += 1;
    if (calls === 1) return new Promise(() => {}); // never resolves → must time out
    return {};
  }, { sleep: noSleep, random: zeroRandom, perAttemptTimeoutMs: 20 });
  assert.equal(r.ok, true, 'second attempt succeeds after the first times out');
  assert.equal(r.attempts, 2);
});
