const test = require('node:test');
const assert = require('node:assert/strict');

const { toSupergroupStyleChatId } = require('../services/leadsTelegramClient');

test('toSupergroupStyleChatId upgrades legacy group ids', () => {
  assert.equal(toSupergroupStyleChatId('-3891925043'), '-1003891925043');
  assert.equal(toSupergroupStyleChatId('-1003891925043'), '-1003891925043');
});
