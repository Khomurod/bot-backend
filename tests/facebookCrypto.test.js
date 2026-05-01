const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';

const { encryptText, decryptText } = require('../services/facebookCrypto');

test('facebook token encryption round-trips plaintext', () => {
  const plain = 'EAAB-test-token-123';
  const encrypted = encryptText(plain);
  assert.notEqual(encrypted, plain);
  assert.equal(decryptText(encrypted), plain);
});

test('facebook token decryption rejects malformed payloads', () => {
  assert.throws(() => decryptText('not-a-valid-payload'), /malformed/i);
});
