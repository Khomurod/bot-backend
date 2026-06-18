const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { BONUS_GROUP_CHAT_ID } = require('../services/mileageBonusConstants');

function loadHandler(mb) {
  const handlerPath = path.resolve(__dirname, '../bot/mileageBonusHandlers.js');
  const mbPath = path.resolve(__dirname, '../database/mileageBonus.js');
  const htmlPath = path.resolve(__dirname, '../services/telegramHtml.js');
  delete require.cache[handlerPath];
  delete require.cache[mbPath];
  delete require.cache[htmlPath];
  require.cache[mbPath] = { exports: mb };
  require.cache[htmlPath] = { exports: { safeSend: async (fn) => fn() } };
  return require(handlerPath);
}

function register(mb) {
  let callback = null;
  const bot = { action(pattern, fn) { callback = fn; } };
  loadHandler(mb).registerMileageBonusHandlers(bot);
  return callback;
}

function context(overrides = {}) {
  const answers = [];
  return {
    match: ['mbonus:paid:7', 'paid', '7'],
    from: { id: 123, username: 'cameron_acc' },
    callbackQuery: { message: { message_id: 50, chat: { id: BONUS_GROUP_CHAT_ID } } },
    async answerCbQuery(text, options) { answers.push({ text, options }); },
    async editMessageText() {},
    telegram: { async sendMessage() { return { message_id: 99 }; } },
    answers,
    ...overrides,
  };
}

test('mileage callback rejects a stale or copied Telegram card', async () => {
  let decisions = 0;
  const row = {
    id: 7,
    status: 'pending',
    action_state: 'idle',
    driver_normalized_name: 'JANE',
    telegram_chat_id: BONUS_GROUP_CHAT_ID,
    telegram_message_id: 60,
  };
  const callback = register({
    async getBonusNotificationById() { return row; },
    async isDriverActive() { return true; },
    async decideBonusNotification() { decisions += 1; },
  });
  const ctx = context();
  await callback(ctx);
  assert.equal(decisions, 0);
  assert.match(ctx.answers[0].text, /old or invalid/);
});

test('mileage callback records a decision only for the current card', async () => {
  const row = {
    id: 7,
    status: 'pending',
    action_state: 'idle',
    driver_normalized_name: 'JANE',
    driver_name: 'Jane',
    threshold_miles: 10000,
    bonus_amount: 200,
    miles_at_notification: 11000,
    period_start: '2026-04-17',
    period_end: '2026-06-07',
    telegram_chat_id: BONUS_GROUP_CHAT_ID,
    telegram_message_id: 50,
  };
  let decisions = 0;
  const callback = register({
    async getBonusNotificationById() { return row; },
    async isDriverActive() { return true; },
    async decideBonusNotification() {
      decisions += 1;
      return { record: { ...row, status: 'paid' }, alreadyDecided: false };
    },
  });
  const ctx = context();
  await callback(ctx);
  assert.equal(decisions, 1);
  assert.match(ctx.answers.at(-1).text, /Marked as paid/);
});
