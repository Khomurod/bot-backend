const test = require('node:test');
const assert = require('node:assert/strict');

const { compilePlan, parsePlan, buildMessageLink } = require('../services/aiAskService');

test('compilePlan enforces time window even when days_back missing', () => {
  const { sql, params } = compilePlan({ filters: [] });
  assert.match(sql, /created_at >= NOW/);
  assert.equal(params[0], 90, 'default window is 90 days');
});

test('compilePlan compiles a simple equality filter with placeholder', () => {
  const { sql, params } = compilePlan({
    days_back: 7,
    filters: [{ field: 'intent', op: '=', value: 'home_time_request' }],
  });
  assert.match(sql, /intent = \$2/);
  assert.equal(params[0], 7);
  assert.equal(params[1], 'home_time_request');
  assert.match(sql, /LIMIT \$\d+/);
});

test('compilePlan supports IN / group_by / aggregate', () => {
  const { sql, params, plan } = compilePlan({
    days_back: 14,
    filters: [{ field: 'intent', op: 'in', value: ['complaint', 'quit_signal'] }],
    group_by: ['sender_name'],
    aggregate: { fn: 'count', field: '*' },
    order_by: [{ field: 'value', dir: 'desc' }],
    limit: 50,
  });
  assert.match(sql, /GROUP BY sender_name/);
  assert.match(sql, /COUNT\(\*\)::INT AS value/);
  assert.match(sql, /IN \(\$2, \$3\)/);
  assert.match(sql, /value DESC/);
  assert.equal(plan.limit, 50);
  assert.equal(params[params.length - 1], 50);
});

test('compilePlan rejects unknown fields', () => {
  assert.throws(
    () => compilePlan({ filters: [{ field: 'ssn', op: '=', value: 'x' }] }),
    /Field not allowed/
  );
});

test('compilePlan rejects unknown operators', () => {
  assert.throws(
    () => compilePlan({ filters: [{ field: 'intent', op: 'delete', value: 'x' }] }),
    /Operator not allowed/
  );
});

test('compilePlan rejects non-whitelisted aggregate function', () => {
  assert.throws(
    () => compilePlan({ group_by: ['sender_name'], aggregate: { fn: 'sum_of_death', field: '*' } }),
    /Aggregate fn not allowed/
  );
});

test('compilePlan rejects non-groupable field in group_by', () => {
  // message_text is allowed to filter but never to group by.
  const { sql } = compilePlan({ group_by: ['message_text'], aggregate: { fn: 'count', field: '*' } });
  // group_by falls to []; so we should not see GROUP BY message_text.
  assert.doesNotMatch(sql, /GROUP BY message_text/);
});

test('compilePlan clamps limit to hard cap', () => {
  const { plan } = compilePlan({ limit: 99999 });
  assert.equal(plan.limit, 200);
});

test('compilePlan supports ILIKE for substring search', () => {
  const { sql, params } = compilePlan({
    days_back: 30,
    filters: [{ field: 'message_text', op: 'ilike', value: '%home%' }],
  });
  assert.match(sql, /message_text ILIKE \$2/);
  assert.equal(params[1], '%home%');
});

test('parsePlan strips code fences', () => {
  assert.deepEqual(
    parsePlan('```json\n{"days_back":7,"filters":[]}\n```'),
    { days_back: 7, filters: [] }
  );
});

test('parsePlan returns null for garbage', () => {
  assert.equal(parsePlan('total nonsense'), null);
});

test('buildMessageLink strips the Telegram -100 prefix', () => {
  // Telegram private supergroup id: -1001234567890 -> t.me/c/1234567890/<msg>
  assert.equal(
    buildMessageLink({ telegram_group_id: -1001234567890, telegram_message_id: 42 }),
    'https://t.me/c/1234567890/42'
  );
});

test('buildMessageLink returns null when ids are missing', () => {
  assert.equal(buildMessageLink({ telegram_group_id: null, telegram_message_id: 42 }), null);
  assert.equal(buildMessageLink({ telegram_group_id: -100, telegram_message_id: null }), null);
});
