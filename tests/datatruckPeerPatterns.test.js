const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isDatatruckPeerUser,
  isDatatruckFailureMessage,
  isDatatruckLoadMessage,
  normalizeUsername,
} = require('../services/datatruckPeerPatterns');

test('normalizeUsername strips @ and lowercases', () => {
  assert.equal(normalizeUsername('@Datatruck_Driver_Bot'), 'datatruck_driver_bot');
});

test('isDatatruckPeerUser matches bot username only', () => {
  assert.equal(isDatatruckPeerUser({ is_bot: true, username: 'datatruck_driver_bot' }, 'datatruck_driver_bot'), true);
  assert.equal(isDatatruckPeerUser({ is_bot: true, username: 'other_bot' }, 'datatruck_driver_bot'), false);
  assert.equal(isDatatruckPeerUser({ is_bot: false, username: 'datatruck_driver_bot' }, 'datatruck_driver_bot'), false);
});

test('isDatatruckFailureMessage detects unknown command and failures', () => {
  assert.equal(isDatatruckFailureMessage('Unknown command. Please use a valid command.'), true);
  assert.equal(isDatatruckFailureMessage("Can't complete the request right now."), true);
  assert.equal(isDatatruckFailureMessage('Load #: 12345'), false);
});

test('isDatatruckLoadMessage detects load content', () => {
  assert.equal(isDatatruckLoadMessage('Load #: 418911'), true);
  assert.equal(isDatatruckLoadMessage('Load type: LIVE\nPU # : 123'), true);
  assert.equal(isDatatruckLoadMessage('/location'), false);
  assert.equal(isDatatruckLoadMessage('Unknown command. Please use a valid command.'), false);
  assert.equal(isDatatruckLoadMessage('Hey team, see you tomorrow'), false);
});

// The load-like cases below came over from tests/loadTextPatterns.test.js when
// that module folded into datatruckPeerPatterns (its last reader) with the
// pinned-load reading's removal, October 2026.
test('isDatatruckLoadMessage: a load number with or without a hash', () => {
  assert.equal(isDatatruckLoadMessage('Load 418911'), true);
  assert.equal(isDatatruckLoadMessage('load 999999'), true);
  assert.equal(isDatatruckLoadMessage('Load: 418911'), true);
  assert.equal(isDatatruckLoadMessage('Load ID: ABC-12'), true);
});

test('isDatatruckLoadMessage: legacy dispatch markers still match', () => {
  assert.equal(isDatatruckLoadMessage('MN>NJ'), true);
  assert.equal(isDatatruckLoadMessage('Live-Drop'), true);
  assert.equal(isDatatruckLoadMessage('RateConfirmation.pdf'), true);
});

test('isDatatruckLoadMessage: slash commands and plain chatter are not load content', () => {
  assert.equal(isDatatruckLoadMessage('/location somewhere'), false);
  assert.equal(isDatatruckLoadMessage('/status'), false);
  assert.equal(isDatatruckLoadMessage(''), false);
});
