'use strict';

/**
 * The inbound-SMS route must not be held open by an AI call.
 *
 * `registerSmsMirror` runs inside an HTTP request the Python leads engine is
 * waiting on, and it awaits the after-hours reply. The AI chain's worst case is
 * not small: three enabled providers, five models each, and a 60-second
 * per-request timeout is FIFTEEN MINUTES if every attempt hangs. The caller
 * would time out long before that, retry, and find the work still running.
 *
 * So the caller is let go after twenty seconds — and the work CARRIES ON. It is
 * not cancelled, because by then an SMS may already be in flight and unsending
 * one is not a thing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const thread = require('../services/recruiting/afterHoursThread');

const ARGS = { driverPhone: '+15551230000', leadName: 'Sam', recruiterId: 7, telegramChatId: -100123 };

// The production deadline timer is deliberately unref'd — it must not hold the
// process open at shutdown — so the timers in THIS file are not, or the runner
// would finish before any of them fired.

test('a prompt answer is returned as itself', async () => {
  const out = await thread.considerAfterHoursReply(ARGS, {
    db: {}, deadlineMs: 5000,
    async considerReply() { return { sent: true, reason: 'replied', text: 'hello' }; },
  });
  assert.deepEqual(out, { sent: true, reason: 'replied', text: 'hello' });
});

test('A SLOW REPLY LETS THE CALLER GO, and says so by name', async () => {
  let finished = false;
  const out = await thread.considerAfterHoursReply(ARGS, {
    db: {}, deadlineMs: 30,
    async considerReply() {
      await new Promise((r) => { setTimeout(r, 400); });
      finished = true;
      return { sent: true, reason: 'replied' };
    },
  });

  assert.deepEqual(out, { sent: false, reason: 'still_working' });
  assert.equal(finished, false, 'the caller did not wait for it');

  // …and the work is still going. It is not cancelled: an SMS may already be in
  // flight, and the mirror row and the counter still have to land.
  await new Promise((r) => { setTimeout(r, 500); });
  assert.equal(finished, true, 'the work carried on without the caller');
});

test('an error inside is a named reason, never a rejection the route has to catch', async () => {
  const out = await thread.considerAfterHoursReply(ARGS, {
    db: {}, deadlineMs: 5000,
    async considerReply() { throw new Error('every provider is down'); },
  });
  assert.equal(out.sent, false);
  assert.equal(out.reason, 'error');
  assert.match(out.detail, /every provider is down/);
});

test('a slow reply that then THROWS cannot become an unhandled rejection', async () => {
  // The dangerous shape: the caller has gone, and the promise nobody is
  // awaiting rejects. Every path inside returns, so it cannot.
  const rejections = [];
  const onUnhandled = (err) => rejections.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const out = await thread.considerAfterHoursReply(ARGS, {
      db: {}, deadlineMs: 20,
      async considerReply() {
        await new Promise((r) => { setTimeout(r, 200); });
        throw new Error('failed after the caller left');
      },
    });
    assert.equal(out.reason, 'still_working');
    await new Promise((r) => { setTimeout(r, 400); });
    assert.deepEqual(rejections, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('the deadline is well under any sane HTTP client timeout', () => {
  assert.ok(thread.REPLY_DEADLINE_MS <= 30_000, 'must not approach a gateway timeout');
  assert.ok(thread.REPLY_DEADLINE_MS >= 5_000, 'but long enough for one ordinary answer');
});

test('the mirror service says the deadline exists, so the next reader knows why it is awaited', () => {
  const src = require('node:fs').readFileSync(
    require.resolve('../services/facebookLeadSmsMirrorService'), 'utf8'
  );
  assert.match(src, /deadline/i);
  assert.match(src, /still_working|carries on/i);
});
