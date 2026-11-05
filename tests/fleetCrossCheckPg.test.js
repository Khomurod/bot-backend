/**
 * The daily Board ↔ Wenze ↔ Datatruck check against a real PostgreSQL: the
 * sweep files a question from the day's Datatruck read, autopilot never
 * applies it, a person's Yes records Datatruck's type, the next sweep resolves
 * it, and the revert puts Wenze's type back. Without the day's read, nothing
 * open is resolved.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { POOL_PATH, purgeDataLayer } = require('./helpers/purgeDataLayer');

const ALL_MIGRATIONS = allMigrationsSql();
const SERVICE_PATHS = [
  '../services/operations/consistencyService', '../services/operations/corrections/actions',
  '../services/operations/corrections/driverTypeActions', '../services/operations/corrections/apply',
  '../services/operations/corrections/autoApply', '../services/operations/snapshot/loaders',
].map((p) => path.resolve(__dirname, `${p}.js`));
const DAILY = require('../services/fleetCrossCheck/daily');

function bind(harness) {
  purgeDataLayer(SERVICE_PATHS);
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true, exports: { pool: harness.pool, query: harness.query, ping: async () => true },
  };
  try {
    const db = { pool: harness.pool, query: harness.query };
    const store = require('../database/operationalFindings');
    const apply = require('../services/operations/corrections/apply');
    const autoApply = require('../services/operations/corrections/autoApply');
    const { runConsistencySweep } = require('../services/operations/consistencyService');
    return {
      sweep: () => runConsistencySweep({ db, store }),
      autoApply: () => autoApply.runAutoCorrections({ apply: true, db, store }),
      applyCorrection: (a) => apply.applyCorrection({ ...a, db }),
      revertCorrection: (a) => apply.revertCorrection({ ...a, db }),
    };
  } finally {
    delete require.cache[POOL_PATH];
    purgeDataLayer(SERVICE_PATHS);
  }
}

/** The day's read, as the boot read would have left it. */
function withDatatruck(t, reading) {
  const shared = DAILY.dailyRead();
  const original = shared.latest;
  shared.latest = () => reading;
  t.after(() => { shared.latest = original; });
}

const READING = {
  readAt: '2026-11-05T12:00:00Z',
  orders: [{ label: '077 (Polvan)', drivers: ['Olugbenga David Onobun'], at: '2026-11-04' }],
  drivers: [{ name: 'Olugbenga David Onobun', driverType: 'company_driver' }],
};

async function seed(harness) {
  await harness.query("INSERT INTO admins (id, username, password_hash) VALUES (1,'admin','x') ON CONFLICT DO NOTHING");
  const g = (await harness.query(
    "INSERT INTO groups (telegram_group_id, group_name, group_type, active) VALUES (-77, 'WENZE UNIT # 077 DAVID ONOBUN OLUGBENGA', 'driver', TRUE) RETURNING id"
  )).rows[0].id;
  await harness.query(
    `INSERT INTO driver_profiles (group_id, first_name, last_name, unit_number, driver_type, truck_fleet, truck_owner, truck_source)
     VALUES ($1, 'DAVID ONOBUN', 'OLUGBENGA', '077', 'owner', 'owner_operator', 'POLVAN', 'board')`, [g]
  );
  const p = (await harness.query("INSERT INTO driver_people (display_name, normalized_key) VALUES ('DAVID ONOBUN OLUGBENGA', 'david onobun olugbenga') RETURNING id")).rows[0].id;
  await harness.query("INSERT INTO driver_person_groups (person_id, group_id, association_source) VALUES ($1, $2, 'backfill')", [p, g]);
  await harness.query(
    "INSERT INTO driver_units (person_id, unit_number, source, fleet_type, truck_owner) VALUES ($1, '077', 'profile', 'owner_operator', 'POLVAN')", [p]
  );
  await harness.query(
    `INSERT INTO dispatch_board_rows (row_key, driver_name_raw, driver_name_clean, fleet_type, fleet_label_raw, truck_raw, truck_norm, status, present)
     VALUES ('k:077', 'OLUGBENGA DAVID ONOBUN', 'OLUGBENGA DAVID ONOBUN', 'owner_operator', '(POLVAN)', '077 (Polvan)', '077', 'ENROUTE', TRUE)`
  );
  return g;
}

const open = async (h, key) => (await h.query(
  "SELECT id, tier, status FROM operational_findings WHERE check_key = $1 AND status = 'open'", [key]
)).rows;
const driverType = async (h, g) => (await h.query('SELECT driver_type FROM driver_profiles WHERE group_id = $1', [g])).rows[0].driver_type;

test('a question from the day\'s read; never by autopilot; a person\'s Yes; resolved; reverted', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  withDatatruck(t, READING);
  const {
    sweep, autoApply, applyCorrection, revertCorrection,
  } = bind(harness);
  const g = await seed(harness);

  await sweep();
  let found = await open(harness, 'fleet.driver_type_differs_datatruck');
  assert.equal(found.length, 1);
  assert.equal(found[0].tier, 'approval');

  await autoApply();
  assert.equal(await driverType(harness, g), 'owner', 'autopilot never applies a question');

  const correction = await applyCorrection({
    actionKey: 'fleet.set_driver_type',
    payload: { groupId: g, from: 'owner', to: 'company_driver' },
    admin: { telegramUserId: '424242' },
    reason: 'Yes in the notification group.',
  });
  assert.equal(await driverType(harness, g), 'company_driver');
  await sweep();
  found = await open(harness, 'fleet.driver_type_differs_datatruck');
  assert.equal(found.length, 0, 'Wenze now agrees with Datatruck: nothing left to ask');
  const profile = (await harness.query('SELECT truck_fleet, truck_owner FROM driver_profiles WHERE group_id = $1', [g])).rows[0];
  assert.deepEqual(profile, { truck_fleet: 'owner_operator', truck_owner: 'POLVAN' }, 'the truck is untouched');

  await revertCorrection({ correctionId: correction.id, admin: { id: 1, username: 'admin', roleKeys: ['super_admin'], ip: null }, reason: 'undo' });
  assert.equal(await driverType(harness, g), 'owner');

  // A stale Yes — the type changed after the question — does nothing.
  await harness.query("UPDATE driver_profiles SET driver_type = 'lease' WHERE group_id = $1", [g]);
  await assert.rejects(applyCorrection({
    actionKey: 'fleet.set_driver_type', payload: { groupId: g, from: 'owner', to: 'company_driver' }, admin: { telegramUserId: '424242' }, reason: 'late',
  }), /now lease/);
  assert.equal(await driverType(harness, g), 'lease');
});

test('without the day\'s Datatruck read nothing open is resolved', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const shared = DAILY.dailyRead();
  const original = shared.latest;
  t.after(() => { shared.latest = original; });
  const { sweep } = bind(harness);
  await seed(harness);

  shared.latest = () => READING;
  await sweep();
  assert.equal((await open(harness, 'fleet.driver_type_differs_datatruck')).length, 1);

  shared.latest = () => null; // restarted, or Datatruck down for two days
  const result = await sweep();
  assert.ok(result.summary.failures.some((f) => f.module === 'fleetCrossCheck'), JSON.stringify(result.summary.failures));
  assert.equal((await open(harness, 'fleet.driver_type_differs_datatruck')).length, 1, 'still open — a missing source is not agreement');
});
