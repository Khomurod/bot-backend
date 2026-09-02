/**
 * Unit tests for database/routeControl.js delivery-metadata writers, with the pg
 * `query` mocked (no real database). Asserts the dynamic UPDATE builds the right
 * SET clauses/values — in particular that a text→photo conversion persists both
 * `driver_group_message_via` and the JSONB `driver_group_messages`, and that
 * undefined parameters leave their columns untouched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { purgeDataLayer, POOL_PATH } = require('./helpers/purgeDataLayer');

function loadRc() {
  const rcPath = path.resolve(__dirname, '../database/routeControl.js');
  const calls = [];
  // database/pool.js is the seam every data-layer module destructures `query`
  // from, so stubbing it covers database/routeControl/* as well as the façade.
  // purgeDataLayer() then drops anything that captured the real `query` first.
  require.cache[POOL_PATH] = {
    id: POOL_PATH,
    filename: POOL_PATH,
    loaded: true,
    exports: {
      async query(sql, values) { calls.push({ sql, values }); return { rows: [{ id: values[0] }] }; },
    },
  };
  purgeDataLayer();
  return { rc: require(rcPath), calls };
}

test.after(() => { delete require.cache[POOL_PATH]; purgeDataLayer(); });

test('recordDriverGroupMessageEdit: only edit timestamp + error by default (other columns untouched)', async () => {
  const { rc, calls } = loadRc();
  await rc.recordDriverGroupMessageEdit(9, {});
  const { sql, values } = calls[0];
  assert.match(sql, /driver_group_message_edited_at = NOW\(\)/);
  assert.match(sql, /driver_group_message_edit_error = \$2/);
  assert.doesNotMatch(sql, /driver_group_message_via/, 'via left unchanged when undefined');
  assert.doesNotMatch(sql, /screenshot_send_error/, 'screenshot error left unchanged when undefined');
  assert.doesNotMatch(sql, /driver_group_messages/, 'message list left unchanged when undefined');
  assert.deepEqual(values, [9, null]);
});

test('recordDriverGroupMessageEdit: a conversion writes via + JSONB message list atomically', async () => {
  const { rc, calls } = loadRc();
  await rc.recordDriverGroupMessageEdit(9, {
    via: 'photo',
    screenshotError: null,
    editError: null,
    messages: [{ message_id: 72, kind: 'photo' }],
  });
  const { sql, values } = calls[0];
  assert.match(sql, /driver_group_message_via = \$3/);
  assert.match(sql, /screenshot_send_error = \$4/);
  assert.match(sql, /driver_group_messages = \$5::jsonb/);
  // Single UPDATE statement → atomic.
  assert.equal((sql.match(/UPDATE route_assignments/g) || []).length, 1);
  assert.equal(values[0], 9);
  assert.equal(values[2], 'photo');
  assert.equal(values[3], null);
  assert.equal(values[4], JSON.stringify([{ message_id: 72, kind: 'photo' }]));
});

test('recordDriverGroupMessageEdit: via without messages omits the message-list clause', async () => {
  const { rc, calls } = loadRc();
  await rc.recordDriverGroupMessageEdit(9, { via: 'photo' });
  const { sql } = calls[0];
  assert.match(sql, /driver_group_message_via/);
  assert.doesNotMatch(sql, /driver_group_messages/);
});

test('recordDriverGroupMessageSent: stores the message list and resets edit bookkeeping', async () => {
  const { rc, calls } = loadRc();
  await rc.recordDriverGroupMessageSent(9, {
    telegramMessageId: 72, sentBy: 'admin', via: 'photo+text', screenshotError: null,
    messages: [{ message_id: 71, kind: 'photo' }, { message_id: 72, kind: 'text' }],
  });
  const { sql, values } = calls[0];
  assert.match(sql, /driver_group_messages = \$6::jsonb/);
  assert.match(sql, /driver_group_message_edited_at = NULL/);
  assert.match(sql, /driver_group_message_edit_error = NULL/);
  assert.equal(values[5], JSON.stringify([{ message_id: 71, kind: 'photo' }, { message_id: 72, kind: 'text' }]));
});
