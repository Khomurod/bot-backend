/**
 * db-level tests for the group_members helpers and the driver_profiles
 * Telegram identity (telegram_user_id + telegram_username) persistence,
 * with the pg Pool mocked via require.cache.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';

// Every pool.query() is routed through this swappable handler so each test
// can script its own responses and capture the SQL + params it received.
let queryHandler = async () => ({ rows: [] });

function loadDbWithMockedPg() {
  const pgPath = require.resolve('pg');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  delete require.cache[dbPath];
  require.cache[pgPath] = {
    exports: {
      Pool: class {
        on() {}
        query(text, params) { return queryHandler(text, params); }
      },
    },
  };
  return require(dbPath);
}

const db = loadDbWithMockedPg();

test('upsertGroupMember inserts/refreshes the (group, user) row', async () => {
  const calls = [];
  queryHandler = async (text, params) => {
    calls.push({ text, params });
    return { rows: [{ group_id: 7, telegram_user_id: '5021' }] };
  };
  const row = await db.upsertGroupMember(7, {
    id: 5021, username: 'joe_d', first_name: 'Joe', last_name: 'D',
  });
  assert.equal(row.telegram_user_id, '5021');
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /INSERT INTO group_members/);
  assert.match(calls[0].text, /ON CONFLICT \(group_id, telegram_user_id\)/);
  assert.deepEqual(calls[0].params, [7, '5021', 'joe_d', 'Joe', 'D']);
});

test('upsertGroupMember rejects invalid group / user ids without querying', async () => {
  queryHandler = async () => { throw new Error('should not query'); };
  assert.equal(await db.upsertGroupMember(7, { id: 'not-a-number' }), null);
  assert.equal(await db.upsertGroupMember(0, { id: 5021 }), null);
  assert.equal(await db.upsertGroupMember(7, null), null);
});

test('removeGroupMember deletes the membership row', async () => {
  const calls = [];
  queryHandler = async (text, params) => { calls.push({ text, params }); return { rows: [] }; };
  await db.removeGroupMember(7, 5021);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /DELETE FROM group_members/);
  assert.deepEqual(calls[0].params, [7, '5021']);
});

test('listGroupMembers returns the rows ordered by recency', async () => {
  const calls = [];
  const stored = [
    { group_id: 7, telegram_user_id: '5021', username: 'joe_d', first_name: 'Joe', last_name: 'D' },
    { group_id: 7, telegram_user_id: '9042', username: null, first_name: 'Silent', last_name: 'Sam' },
  ];
  queryHandler = async (text, params) => { calls.push({ text, params }); return { rows: stored }; };
  const rows = await db.listGroupMembers(7);
  assert.deepEqual(rows, stored);
  assert.match(calls[0].text, /FROM group_members/);
  assert.match(calls[0].text, /ORDER BY last_seen_at DESC/);
  assert.deepEqual(calls[0].params, [7]);
});

// ─── driver_profiles Telegram identity persistence ───

// Minimal existing profile row as getDriverProfileById/ByGroupId would return.
function existingProfileRow(overrides = {}) {
  return {
    id: 3,
    group_id: 7,
    group_name: 'John Smith / 402',
    telegram_group_id: '-1001',
    status_source: 'manual',
    first_name: 'John',
    last_name: 'Smith',
    secondary_first_name: null,
    secondary_last_name: null,
    first_name_source: 'manual',
    last_name_source: 'manual',
    secondary_first_name_source: null,
    secondary_last_name_source: null,
    driver_type: 'company_driver',
    driver_type_source: 'manual',
    status: 'active',
    unit_number: '402',
    unit_number_source: 'manual',
    language: 'en',
    date_of_birth: null,
    date_of_start: null,
    needs_review: false,
    backfill_confidence: 95,
    telegram_username: null,
    telegram_user_id: null,
    ...overrides,
  };
}

// Dispatches the queries updateDriverProfile issues, recording each one.
function profileQueryHandler(state, calls) {
  return async (text, params) => {
    calls.push({ text, params });
    if (/FROM driver_profiles dp/.test(text) && /WHERE dp\.id = \$1/.test(text)) {
      return { rows: [state.row] };
    }
    if (/INSERT INTO driver_profiles/.test(text)) {
      return { rows: [state.row] };
    }
    if (/UPDATE groups/.test(text)) {
      return { rows: [{ id: state.row.group_id }] };
    }
    if (/UPDATE driver_profiles/.test(text) && /SET telegram_user_id = \$2/.test(text)) {
      state.row = { ...state.row, telegram_user_id: params[1], telegram_username: params[2] };
      return { rows: [state.row] };
    }
    if (/FROM driver_profiles dp/.test(text) && /WHERE dp\.group_id = \$1/.test(text)) {
      return { rows: [state.row] };
    }
    return { rows: [] };
  };
}

test('updateDriverProfile persists a selected member id + username via direct UPDATE', async () => {
  const state = { row: existingProfileRow() };
  const calls = [];
  queryHandler = profileQueryHandler(state, calls);

  const updated = await db.updateDriverProfile(3, {
    telegram_user_id: '987654321',
    telegram_username: '@Joe_D',
  });

  const identityUpdate = calls.find((c) => /SET telegram_user_id = \$2/.test(c.text));
  assert.ok(identityUpdate, 'expected the identity UPDATE to run');
  // id kept as a digit string (BIGINT-safe), username normalized (@ stripped, lowercased)
  assert.deepEqual(identityUpdate.params, [7, '987654321', 'joe_d']);
  assert.equal(updated.telegram_user_id, '987654321');
  assert.equal(updated.telegram_username, 'joe_d');
});

test('updateDriverProfile clears the identity when nulls are passed explicitly', async () => {
  const state = { row: existingProfileRow({ telegram_user_id: '11', telegram_username: 'old' }) };
  const calls = [];
  queryHandler = profileQueryHandler(state, calls);

  const updated = await db.updateDriverProfile(3, {
    telegram_user_id: null,
    telegram_username: null,
  });

  const identityUpdate = calls.find((c) => /SET telegram_user_id = \$2/.test(c.text));
  assert.deepEqual(identityUpdate.params, [7, null, null]);
  assert.equal(updated.telegram_user_id, null);
  assert.equal(updated.telegram_username, null);
});

test('updateDriverProfile without identity keys never touches the stored identity', async () => {
  const state = { row: existingProfileRow({ telegram_user_id: '11', telegram_username: 'keepme' }) };
  const calls = [];
  queryHandler = profileQueryHandler(state, calls);

  const updated = await db.updateDriverProfile(3, { unit_number: '911' });

  assert.equal(calls.some((c) => /SET telegram_user_id = \$2/.test(c.text)), false);
  // The upsert must COALESCE-preserve both identity columns so AI sync /
  // backfill writers (which never send them) cannot wipe the admin selection.
  const upsert = calls.find((c) => /INSERT INTO driver_profiles/.test(c.text));
  assert.match(upsert.text, /telegram_username = COALESCE\(EXCLUDED\.telegram_username, driver_profiles\.telegram_username\)/);
  assert.match(upsert.text, /telegram_user_id = COALESCE\(EXCLUDED\.telegram_user_id, driver_profiles\.telegram_user_id\)/);
  assert.equal(updated.telegram_user_id, '11');
  assert.equal(updated.telegram_username, 'keepme');
});
