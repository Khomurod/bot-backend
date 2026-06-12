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
