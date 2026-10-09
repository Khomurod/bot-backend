'use strict';

/**
 * The Finance Monitor's settings row, read at most once per ten minutes.
 *
 * October 2026: `isFinanceChat` asks on every message in every chat, and a
 * 30-second cache re-read the row some 2,400 times a day while the database's
 * transfer allowance was nearly spent. A save still takes effect at once.
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MOD = path.resolve(__dirname, '../database/financeSettings.js');
const DB = path.resolve(__dirname, '../database/db.js');

test('the settings are read once per ten minutes, and at once after a save', async (t) => {
  let reads = 0;
  delete require.cache[MOD];
  require.cache[DB] = {
    id: DB, filename: DB, loaded: true,
    exports: { query: async () => { reads += 1; return { rows: [{ id: 1, enabled: true, chat_id: '-100123' }] }; } },
  };
  t.after(() => { delete require.cache[MOD]; delete require.cache[DB]; });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') });
  // eslint-disable-next-line global-require
  const settings = require(MOD);
  assert.ok(settings.CACHE_TTL_MS >= 10 * 60 * 1000);

  assert.equal(await settings.isFinanceChat('-100123'), true);
  t.mock.timers.tick(9 * 60 * 1000);
  assert.equal(await settings.isFinanceChat('-100123'), true);
  assert.equal(reads, 1, 'nine minutes of messages cost one read');
  settings.invalidateCache();
  await settings.getFinanceSettings();
  assert.equal(reads, 2, 'a save (which invalidates) is read at once');
});
