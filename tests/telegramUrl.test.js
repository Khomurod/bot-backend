const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTelegramMessageUrl } = require('../services/telegramUrl');

test('formats Telegram supergroup id and message id into t.me/c URL', () => {
  const result = buildTelegramMessageUrl('-100987654321', 1050);
  assert.equal(result, 'https://t.me/c/987654321/1050');
});
