/**
 * The race boards' restore after a restart, against a real PostgreSQL: the
 * last day's SENT birthdays come back — an employee's `:sent` mark, a driver's
 * per-group key — with the truck on the driver's profile; an employee claim
 * still in progress and anything older than a day do not.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { POOL_PATH, purgeDataLayer } = require('./helpers/purgeDataLayer');
const { createBirthdayBoard } = require('../services/grossRace/birthdays');

const ALL_MIGRATIONS = allMigrationsSql();
const SERVICE_PATHS = ['../services/grossRace/birthdayRestore'].map((p) => path.resolve(__dirname, `${p}.js`));

function bind(harness) {
  purgeDataLayer(SERVICE_PATHS);
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true, exports: { pool: harness.pool, query: harness.query, ping: async () => true },
  };
  try {
    return { db: require('../database/raceBirthdays'), restore: require('../services/grossRace/birthdayRestore').restoreRaceBirthdays };
  } finally {
    delete require.cache[POOL_PATH];
    purgeDataLayer(SERVICE_PATHS);
  }
}

test('the last day\'s sends come back on the boards; a claim in progress and yesterday\'s do not', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { db, restore } = bind(h);
  const e1 = (await h.query("INSERT INTO employee_birthdays (first_name, last_name, birthday, american_name) VALUES ('TESTBEK', 'ONE', '1990-11-06', 'Tom') RETURNING id")).rows[0].id;
  const e2 = (await h.query("INSERT INTO employee_birthdays (first_name, last_name, birthday) VALUES ('SECOND', 'TWO', '1991-11-06') RETURNING id")).rows[0].id;
  const g = (await h.query("INSERT INTO groups (telegram_group_id, group_name, group_type, active) VALUES (-901, 'WENZE UNIT # 1109 JOHN SMITH', 'driver', TRUE) RETURNING id")).rows[0].id;
  await h.query("INSERT INTO driver_profiles (group_id, first_name, unit_number) VALUES ($1, 'JOHN', '1109')", [g]);
  const old = (await h.query("INSERT INTO groups (telegram_group_id, group_name, group_type, active) VALUES (-902, 'WENZE UNIT # 77 ANN LEE', 'driver', TRUE) RETURNING id")).rows[0].id;
  await h.query(
    `INSERT INTO service_runs (service_name, run_key, ran_at) VALUES
       ('birthday', $1, NOW() - INTERVAL '2 hours'),
       ('birthday', $2, NOW() - INTERVAL '1 minute'),
       ('birthday', $3, NOW() - INTERVAL '3 hours'),
       ('birthday', $4, NOW() - INTERVAL '30 hours'),
       ('weekly', 'driver:1:2026-11-06', NOW())`,
    [`employee:2026-11-07:${e1}:sent`, `employee:2026-11-07:${e2}`, `driver:${g}:2026-11-06`, `driver:${old}:2026-11-05`]
  );

  const sends = await db.getRecentBirthdaySends();
  assert.deepEqual(sends.map((s) => s.runKey).sort(), [`driver:${g}:2026-11-06`, `employee:2026-11-07:${e1}:sent`].sort());
  const age = sends.find((s) => s.runKey.startsWith('driver:')).ageSeconds;
  assert.ok(Math.abs(age - 3 * 3600) < 120, `ages from the database's own clock (${age})`);

  const board = createBirthdayBoard();
  const n = await restore({ db, board, prepareCard: async () => Buffer.from([0xff, 0xd8]), log: { log() {}, warn() {} } });
  assert.equal(n, 2);
  assert.deepEqual(board.todaysBirthdays().map((b) => [b.kind, b.name, b.subtitle, b.truck, Boolean(b.card)]), [
    ['driver', 'John Smith', null, '1109', false],
    ['employee', 'Testbek', 'Tom', null, true],
  ]);
});
