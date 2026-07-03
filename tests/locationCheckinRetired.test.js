/**
 * The pickup/delivery "Checked In / Checked Out" location-monitor feature was
 * retired. The poller no longer sends prompts, but old messages may still carry
 * old buttons. This test verifies the retired stub:
 *   - registers a handler that matches the legacy `loccheck:*` callbacks,
 *   - answers a stale tap with the retirement notice,
 *   - never throws and performs no database work (it requires no DB module).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  registerLocationCheckinHandlers,
  RETIRED_MESSAGE,
} = require('../bot/locationCheckinHandlers');

function fakeBot() {
  const actions = [];
  return {
    actions,
    action(matcher, handler) {
      actions.push({ matcher, handler });
    },
  };
}

function fakeCtx(callbackData) {
  const answered = [];
  return {
    answered,
    from: { id: 42, username: 'driver' },
    callbackQuery: { data: callbackData, message: { chat: { id: -100 }, message_id: 7 } },
    async answerCbQuery(text, opts) {
      answered.push({ text, opts });
    },
  };
}

test('retired stub registers a loccheck matcher that catches legacy in/out callbacks', () => {
  const bot = fakeBot();
  registerLocationCheckinHandlers(bot);

  assert.equal(bot.actions.length, 1, 'exactly one handler registered');
  const { matcher } = bot.actions[0];
  assert.ok(matcher instanceof RegExp);
  assert.equal(matcher.test('loccheck:in:555'), true);
  assert.equal(matcher.test('loccheck:out:555'), true);
  assert.equal(matcher.test('loccheck:out'), true);
  assert.equal(matcher.test('mileage:paid:1'), false, 'does not shadow unrelated callbacks');
});

test('a stale Checked In / Checked Out tap gets the retirement notice and never throws', async () => {
  const bot = fakeBot();
  registerLocationCheckinHandlers(bot);
  const { handler } = bot.actions[0];

  for (const data of ['loccheck:in:555', 'loccheck:out:555']) {
    const ctx = fakeCtx(data);
    await assert.doesNotReject(() => handler(ctx));
    assert.equal(ctx.answered.length, 1);
    assert.equal(ctx.answered[0].text, RETIRED_MESSAGE);
    assert.equal(ctx.answered[0].opts?.show_alert, true);
  }
});

test('a failing answerCbQuery (expired button) does not surface as an unhandled rejection', async () => {
  const bot = fakeBot();
  registerLocationCheckinHandlers(bot);
  const { handler } = bot.actions[0];

  const ctx = {
    from: { id: 1 },
    callbackQuery: { data: 'loccheck:in:1' },
    async answerCbQuery() {
      throw new Error('query is too old and response timeout expired');
    },
  };
  await assert.doesNotReject(() => handler(ctx));
});
