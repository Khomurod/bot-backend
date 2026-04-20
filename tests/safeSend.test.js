const test = require('node:test');
const assert = require('node:assert/strict');
const { safeSend, isPermanentSendError } = require('../services/telegramHtml');

test('safeSend returns immediately on success', async () => {
  let calls = 0;
  const result = await safeSend(() => {
    calls += 1;
    return Promise.resolve('ok');
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('safeSend retries transient failures with exponential backoff (bounded attempts)', async () => {
  let calls = 0;
  const err = new Error('server hiccup');
  const result = await safeSend(
    () => {
      calls += 1;
      if (calls < 3) return Promise.reject(err);
      return Promise.resolve('ok');
    },
    { maxAttempts: 4, baseDelayMs: 1 }
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('safeSend honors 429 retry_after before retrying', async () => {
  let calls = 0;
  const start = Date.now();
  const err = Object.assign(new Error('429'), {
    response: { error_code: 429, parameters: { retry_after: 0 } },
  });
  const result = await safeSend(
    () => {
      calls += 1;
      if (calls < 2) return Promise.reject(err);
      return Promise.resolve('ok');
    },
    { maxAttempts: 2, baseDelayMs: 1 }
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
  assert.ok(Date.now() - start >= 250, 'should sleep at least retry_after*1000 + 250ms cushion');
});

test('safeSend gives up on permanent errors (403 chat kicked)', async () => {
  let calls = 0;
  const permanent = Object.assign(new Error('kicked'), {
    response: { error_code: 403, description: 'Forbidden: bot was kicked from the group chat' },
  });
  await assert.rejects(
    () => safeSend(
      () => {
        calls += 1;
        return Promise.reject(permanent);
      },
      { maxAttempts: 5, baseDelayMs: 1 }
    ),
    /kicked/
  );
  assert.equal(calls, 1, 'permanent errors must not be retried');
});

test('isPermanentSendError classifies known terminal cases', () => {
  assert.equal(isPermanentSendError({ response: { error_code: 403 } }), true);
  assert.equal(
    isPermanentSendError({ response: { error_code: 400, description: 'Bad Request: chat not found' } }),
    true
  );
  assert.equal(isPermanentSendError({ response: { error_code: 500 } }), false);
  assert.equal(isPermanentSendError({}), false);
});
