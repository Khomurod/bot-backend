/**
 * Bot confirmation phrasing for possession + cargo (multi-trailer summary lines).
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-bot-token-2';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test-key';
process.env.CORS_ALLOW_ALL ||= 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const { statePhrase } = require('../services/trailerMonitorService');

test('pickup with unknown cargo → "with driver"', () => {
  assert.equal(statePhrase({ possession_status: 'with_driver', cargo_status: 'unknown' }), 'with driver');
});
test('dropoff empty → "dropped empty"', () => {
  assert.equal(statePhrase({ possession_status: 'dropped', cargo_status: 'empty' }), 'dropped empty');
});
test('dropoff loaded → "dropped loaded"', () => {
  assert.equal(statePhrase({ possession_status: 'dropped', cargo_status: 'loaded' }), 'dropped loaded');
});
test('pickup empty → "with driver empty"', () => {
  assert.equal(statePhrase({ possession_status: 'with_driver', cargo_status: 'empty' }), 'with driver empty');
});
