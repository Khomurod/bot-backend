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

test('A SAVE DURING A READ is not undone by that read — the old row is not kept for ten minutes', async (t) => {
  // A read starts, an operator saves (which clears the cache), and the read
  // finishes afterwards with the row as it was BEFORE the save. Kept, it would
  // point the Finance Monitor at the old chat for the whole TTL.
  let reads = 0;
  let release;
  delete require.cache[MOD];
  require.cache[DB] = {
    id: DB, filename: DB, loaded: true,
    exports: {
      query: async () => {
        reads += 1;
        if (reads === 1) await new Promise((r) => { release = r; });
        return { rows: [{ id: 1, enabled: true, chat_id: reads === 1 ? '-100OLD' : '-100NEW' }] };
      },
    },
  };
  t.after(() => { delete require.cache[MOD]; delete require.cache[DB]; });
  // eslint-disable-next-line global-require
  const settings = require(MOD);

  const inFlight = settings.getFinanceSettings();
  await new Promise((r) => setImmediate(r));
  settings.invalidateCache(); // the save lands while the read is still out
  release();
  assert.equal((await inFlight).chatId, '-100OLD', 'the slow read still answers its own caller');
  assert.equal(await settings.isFinanceChat('-100NEW'), true, 'but the next read goes to the table');
  assert.equal(reads, 2);
});
