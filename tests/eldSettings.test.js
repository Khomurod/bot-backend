const test = require('node:test');
const assert = require('node:assert/strict');

// Ensure config's required env vars exist before requiring modules that load it.
process.env.DATABASE_URL ||= 'postgres://test';
process.env.JWT_SECRET ||= 'test-secret';
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-telegram-token';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test-fb-key';

const { looksLikeDocsUrl, DEFAULT_DRIVEHOS_API_BASE } = require('../database/eldSettings');

test('looksLikeDocsUrl flags Swagger / documentation URLs', () => {
  assert.equal(looksLikeDocsUrl('https://api.drivehos.app/swagger/index.html'), true);
  assert.equal(looksLikeDocsUrl('https://api.drivehos.app/swagger-ui'), true);
  assert.equal(looksLikeDocsUrl('https://docs.drivehos.app/index.html'), true);
  assert.equal(looksLikeDocsUrl('https://api.drivehos.app/#/vehicles'), true);
  assert.equal(looksLikeDocsUrl('https://api.drivehos.app/api-docs'), true);
});

test('looksLikeDocsUrl accepts a real API host', () => {
  assert.equal(looksLikeDocsUrl('https://api.drivehos.app'), false);
  assert.equal(looksLikeDocsUrl('https://api.drivehos.app/'), false);
  assert.equal(looksLikeDocsUrl(''), false);
  assert.equal(looksLikeDocsUrl(null), false);
});

test('DEFAULT_DRIVEHOS_API_BASE is the real API host', () => {
  assert.equal(DEFAULT_DRIVEHOS_API_BASE, 'https://api.drivehos.app');
});
