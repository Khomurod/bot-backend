const test = require('node:test');
const assert = require('node:assert/strict');

const {
  safeFieldValue,
  buildLeadFieldMap,
  formatLeadMessage,
  formatMessengerMessage,
} = require('../services/facebookLeadFormatter');

test('safeFieldValue joins array values and tolerates strings', () => {
  assert.equal(safeFieldValue({ values: ['one', 'two'] }), 'one, two');
  assert.equal(safeFieldValue({ values: 'solo' }), 'solo');
  assert.equal(safeFieldValue({ values: null }), '');
});

test('buildLeadFieldMap includes only named non-empty fields', () => {
  const map = buildLeadFieldMap({
    field_data: [
      { name: 'full_name', values: ['Alice Example'] },
      { name: 'phone_number', values: ['+15551234567'] },
      { name: 'empty', values: [] },
      { values: ['missing-name'] },
    ],
  });

  assert.deepEqual(map, {
    full_name: 'Alice Example',
    phone_number: '+15551234567',
  });
});

test('formatLeadMessage produces readable lead summary text', () => {
  const message = formatLeadMessage({
    id: '12345',
    created_time: '2026-05-01T12:00:00+0000',
    field_data: [
      { name: 'full_name', values: ['Alice Example'] },
      { name: 'email', values: ['alice@example.com'] },
      { name: 'phone_number', values: ['+15551234567'] },
    ],
  });

  assert.match(message, /New Facebook Lead!/);
  assert.match(message, /Alice Example/);
  assert.match(message, /alice@example.com/);
  assert.match(message, /Lead ID: 12345/);
});

test('formatMessengerMessage includes inbox shortcut and sender id', () => {
  const message = formatMessengerMessage(
    { first_name: 'John', last_name: 'Doe' },
    'Hello there',
    '987'
  );

  assert.match(message, /John Doe/);
  assert.match(message, /Sender ID: 987/);
  assert.match(message, /Hello there/);
  assert.match(message, /business\.facebook\.com/);
});
