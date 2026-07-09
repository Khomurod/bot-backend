/**
 * Tests for the driver-profile Telegram identity write path used by the admin
 * Driver Groups modal (manual username entry + "seen member" dropdown) and the
 * opportunistic username → numeric-id backfill.
 *
 * database/db.js owns the normalization/persistence, so we mock the `pg` Pool
 * and assert the exact SQL parameters it would send. This proves:
 *   - manual "@username" / "username" are stored normalized (no '@', lowercased)
 *   - a dropdown selection stores BOTH the numeric id and the username
 *   - "clear" nulls both fields
 *   - backfill only fills a NULL id, is scoped to the group, matches by username
 */
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.TELEGRAM_BOT_TOKEN ||= 'test-telegram-bot-token';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test-fb-key';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * Load database/db.js with the `pg` Pool replaced by a fake whose `.query`
 * records every call and returns scripted results. Returns { db, calls, setNext }.
 */
function loadDbWithFakePg() {
  const calls = [];
  let nextResult = { rows: [], rowCount: 0 };
  class FakePool {
    on() {}
    async query(text, params) {
      calls.push({ sql: String(text).replace(/\s+/g, ' ').trim(), params });
      // A SELECT (getDriverProfileByGroupId follow-up) returns a stored row so
      // the mapper does not blow up; UPDATEs return the scripted result.
      if (/^SELECT/i.test(String(text).trim())) {
        return { rows: [{ group_id: params?.[0], group_name: 'Test Group' }], rowCount: 1 };
      }
      return nextResult;
    }
  }
  const pgPath = require.resolve('pg');
  require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: FakePool } };
  // The Pool is created in database/pool.js and shared by every feature module
  // under database/, so clear the whole directory from the cache — otherwise a
  // previous load's pool (bound to a previous FakePool + calls array) survives.
  const databaseDir = path.resolve(__dirname, '../database') + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(databaseDir)) delete require.cache[key];
  }
  const dbPath = require.resolve(path.resolve(__dirname, '../database/db.js'));
  const db = require(dbPath);
  return {
    db,
    calls,
    setNext: (result) => { nextResult = result; },
  };
}

function lastUpdateParams(calls) {
  const update = [...calls].reverse().find((c) => /^UPDATE driver_profiles/i.test(c.sql));
  return update ? update.params : null;
}

test('manual "@username" is stored normalized (no @, lowercased); no id set', async () => {
  const { db, calls } = loadDbWithFakePg();
  await db.setDriverProfileTelegramIdentity(7, { telegramUserId: null, telegramUsername: '@John_Driver' });
  const params = lastUpdateParams(calls);
  assert.equal(params[0], 7);          // group_id
  assert.equal(params[1], null);       // telegram_user_id
  assert.equal(params[2], 'john_driver'); // normalized username
});

test('manual "username" (no @) is stored normalized', async () => {
  const { db, calls } = loadDbWithFakePg();
  await db.setDriverProfileTelegramIdentity(7, { telegramUsername: 'John_Driver' });
  assert.equal(lastUpdateParams(calls)[2], 'john_driver');
});

test('dropdown selection stores BOTH the numeric id and the username', async () => {
  const { db, calls } = loadDbWithFakePg();
  await db.setDriverProfileTelegramIdentity(7, { telegramUserId: '558912345', telegramUsername: 'JoeD_99' });
  const params = lastUpdateParams(calls);
  assert.equal(params[1], '558912345'); // id kept as canonical digit string
  assert.equal(params[2], 'joed_99');
});

test('clear nulls BOTH id and username', async () => {
  const { db, calls } = loadDbWithFakePg();
  await db.setDriverProfileTelegramIdentity(7, { telegramUserId: null, telegramUsername: null });
  const params = lastUpdateParams(calls);
  assert.equal(params[1], null);
  assert.equal(params[2], null);
});

test('invalid numeric id is rejected (normalized to null), username still saved', async () => {
  const { db, calls } = loadDbWithFakePg();
  await db.setDriverProfileTelegramIdentity(7, { telegramUserId: 'not-a-number', telegramUsername: 'good_name' });
  const params = lastUpdateParams(calls);
  assert.equal(params[1], null);
  assert.equal(params[2], 'good_name');
});

test('backfill fills a NULL id only, scoped to the group, matched by username', async () => {
  const { db, calls, setNext } = loadDbWithFakePg();
  setNext({ rows: [], rowCount: 1 });
  const filled = await db.backfillDriverProfileTelegramUserId({
    groupId: 42, telegramUserId: 987654321, username: '@John_Driver',
  });
  assert.equal(filled, true);
  const update = calls.find((c) => /^UPDATE driver_profiles/i.test(c.sql));
  assert.match(update.sql, /telegram_user_id IS NULL/);
  assert.match(update.sql, /LOWER\(telegram_username\) = \$3/);
  assert.deepEqual(update.params, [42, '987654321', 'john_driver']);
});

test('backfill returns false and issues NO query for incomplete input', async () => {
  for (const bad of [
    { groupId: null, telegramUserId: 5, username: 'joe_driver' },
    { groupId: 42, telegramUserId: null, username: 'joe_driver' },
    { groupId: 42, telegramUserId: 5, username: '' },
    {},
  ]) {
    const { db, calls } = loadDbWithFakePg();
    const filled = await db.backfillDriverProfileTelegramUserId(bad);
    assert.equal(filled, false);
    assert.equal(calls.length, 0, `expected no query for ${JSON.stringify(bad)}`);
  }
});

test('backfill returns false when no matching NULL-id row exists', async () => {
  const { db, setNext } = loadDbWithFakePg();
  setNext({ rows: [], rowCount: 0 });
  const filled = await db.backfillDriverProfileTelegramUserId({
    groupId: 42, telegramUserId: 5, username: 'joe_driver',
  });
  assert.equal(filled, false);
});
