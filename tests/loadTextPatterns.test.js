const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractLoadIdentifier,
  isLoadLikeChatMessage,
} = require('../services/loadTextPatterns');

test('isLoadLikeChatMessage: Load number without hash', () => {
  assert.equal(isLoadLikeChatMessage('Load 418911'), true);
  assert.equal(isLoadLikeChatMessage('load 999999'), true);
});

test('isLoadLikeChatMessage: Load with colon or explicit id', () => {
  assert.equal(isLoadLikeChatMessage('Load: 418911'), true);
  assert.equal(isLoadLikeChatMessage('Load ID: ABC-12'), true);
});

test('isLoadLikeChatMessage: legacy dispatch markers still match', () => {
  assert.equal(isLoadLikeChatMessage('MN>NJ'), true);
  assert.equal(isLoadLikeChatMessage('Live-Drop'), true);
  assert.equal(isLoadLikeChatMessage('RateConfirmation.pdf'), true);
});

test('isLoadLikeChatMessage: ignores slash bot commands', () => {
  assert.equal(isLoadLikeChatMessage('/location somewhere'), false);
  assert.equal(isLoadLikeChatMessage('/status'), false);
});

test('isLoadLikeChatMessage: plain chatter', () => {
  assert.equal(isLoadLikeChatMessage('See you tomorrow'), false);
  assert.equal(isLoadLikeChatMessage(''), false);
});

test('extractLoadIdentifier: bare numeric load', () => {
  assert.equal(extractLoadIdentifier('Load 418911\nLive-Drop'), '418911');
  assert.equal(extractLoadIdentifier('Top line\nLoad 999888 bottom'), '999888');
});

test('extractLoadIdentifier: prefers explicit markers over bare number', () => {
  assert.equal(extractLoadIdentifier('Load # 111\nLoad 222'), '111');
  assert.equal(extractLoadIdentifier('Load: XYZ-9'), 'XYZ-9');
});
