const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTelegramUsername, isValidTelegramUsername, formatTelegramUsername,
} = require('../lib/telegram/telegramUsername');

test('normalizeTelegramUsername strips @, trims, lowercases', () => {
  assert.equal(normalizeTelegramUsername('@John_Dispatch'), 'john_dispatch');
  assert.equal(normalizeTelegramUsername('  JohnDispatch '), 'johndispatch');
  assert.equal(normalizeTelegramUsername('@@weird'), 'weird');
  assert.equal(normalizeTelegramUsername(''), null);
  assert.equal(normalizeTelegramUsername(null), null);
  assert.equal(normalizeTelegramUsername('@'), null);
});

test('isValidTelegramUsername enforces 5-32 char shape on normalized form', () => {
  assert.equal(isValidTelegramUsername('john_dispatch'), true);
  assert.equal(isValidTelegramUsername('@John_Dispatch'), true);
  assert.equal(isValidTelegramUsername('abcd'), false); // too short
  assert.equal(isValidTelegramUsername('has space'), false);
  assert.equal(isValidTelegramUsername('bad-dash'), false);
  assert.equal(isValidTelegramUsername(''), false);
});

test('formatTelegramUsername adds a single @', () => {
  assert.equal(formatTelegramUsername('john'), '@john');
  assert.equal(formatTelegramUsername('@John'), '@john');
  assert.equal(formatTelegramUsername(''), null);
});
