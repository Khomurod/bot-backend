/**
 * A truck is (fleet, number, OWNER, seat) — against a real PostgreSQL.
 *
 * The owner's decisions of 5 November 2026: the name after a board number is
 * the truck's owner ("1 ERNST", "1 ROGER" are two trucks), and a driver hired
 * by an owner drives an owner's truck as a company driver. Migration 0093 adds
 * the owner to the truck's name; `identity.truck_from_board` copies the board's
 * truck onto the profile; the existing sync brings the truck record along.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { POOL_PATH, purgeDataLayer } = require('./helpers/purgeDataLayer');

const ALL_MIGRATIONS = allMigrationsSql();
const SERVICE_PATHS = [
  '../services/identity/personResolver', '../services/operations/consistencyService', '../services/operations/corrections/actions',
  '../services/operations/corrections/identityActions', '../services/operations/corrections/unitFleetActions',
  '../services/operations/corrections/truckFromBoardActions', '../services/operations/corrections/unitHandoverActions',
  '../services/operations/corrections/apply', '../services/operations/corrections/autoApply',
].map((p) => path.resolve(__dirname, `${p}.js`));

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
    const resolver = require('../services/identity/personResolver');
    resolver.resetResolverCache();
    return {
      resolver,
      sweep: () => runConsistencySweep({ db, store }),
      revertCorrection: (a) => apply.revertCorrection({ ...a, db }),
      autoApply: () => autoApply.runAutoCorrections({ apply: true, db, store }),
    };
  } finally {
    delete require.cache[POOL_PATH];
    purgeDataLayer(SERVICE_PATHS);
  }
}

async function harnessWith(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await harness.query("INSERT INTO admins (id, username, password_hash) VALUES (1,'admin','x') ON CONFLICT DO NOTHING");
  return harness;
}

async function chat(harness, { tg, name, first, last, unit, type }) {
  const g = await harness.query(
    "INSERT INTO groups (telegram_group_id, group_name, group_type, active) VALUES ($1, $2, 'driver', TRUE) RETURNING *", [tg, name]
  );
  await harness.query(
    'INSERT INTO driver_profiles (group_id, first_name, last_name, unit_number, driver_type) VALUES ($1, $2, $3, $4, $5)',
    [g.rows[0].id, first, last, unit, type]
  );
  return g.rows[0];
}

async function boardLine(harness, { truckRaw, unit, fleet, label, driver }) {
  await harness.query(
    `INSERT INTO dispatch_board_rows (row_key, driver_name_raw, driver_name_clean, fleet_type, fleet_label_raw, truck_raw, truck_norm, status, present)
     VALUES ($1, $2, $2, $3, $4, $5, $6, 'DISPATCHED', TRUE)`,
    [`k:${truckRaw}`, driver, fleet, label, truckRaw, unit]
  );
}

const openTrucks = async (harness) => (await harness.query(
  `SELECT p.display_name, u.unit_number, u.fleet_type, u.truck_owner FROM driver_units u
     JOIN driver_people p ON p.id = u.person_id WHERE u.ended_at IS NULL ORDER BY u.truck_owner NULLS FIRST`
)).rows.map((r) => [r.display_name, r.unit_number, r.fleet_type, r.truck_owner]);

test('the index admits two owners\' trucks on one number, and still refuses one truck held twice', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const people = [];
  for (const n of ['A', 'B', 'C']) {
    // eslint-disable-next-line no-await-in-loop
    people.push((await harness.query(`INSERT INTO driver_people (display_name, normalized_key) VALUES ($1, $1) RETURNING id`, [n])).rows[0].id);
  }
  const open = (personId, owner) => harness.query(
    `INSERT INTO driver_units (person_id, unit_number, source, fleet_type, truck_owner) VALUES ($1, '1', 'manual', 'owner_operator', $2)`,
    [personId, owner]
  );
  await open(people[0], 'ERNST');
  await open(people[1], 'ROGER');
  await assert.rejects(open(people[2], 'ROGER'), /unique|duplicate/i, 'one truck, one driver');
});

test('the board names each driver\'s truck; Wenze records 1 ERNST and 1 ROGER as two trucks by itself', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { sweep, autoApply, resolver } = bind(harness);
  const jerome = await chat(harness, { tg: -11, name: 'WENZE UNIT # 1 JEROME JOYNER', first: 'JEROME', last: 'JOYNER', unit: '1', type: 'owner' });
  const roger = await chat(harness, { tg: -12, name: 'WENZE UNIT # 1 ROGER ALCIDE', first: 'ROGER', last: 'ALCIDE', unit: '1', type: 'owner' });
  const pj = (await resolver.ensurePersonForGroup(jerome)).personId;
  await resolver.ensurePersonForGroup(roger);
  // Today's shape: one owner-operator "1", held by whoever got there first,
  // and Roger — on the same number, in another owner's truck — has none.
  await resolver.syncUnitForPerson(pj, '1', { fleetType: 'owner_operator' });
  assert.equal((await openTrucks(harness)).length, 1);
  await boardLine(harness, { truckRaw: '1 ERNST', unit: '1', fleet: 'owner_operator', label: 'ERNST', driver: 'JEROME JOYNER' });
  await boardLine(harness, { truckRaw: '1 ROGER', unit: '1', fleet: 'owner_operator', label: 'ROGER', driver: 'Roger Alcide' });

  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await sweep();
    // eslint-disable-next-line no-await-in-loop
    await autoApply();
  }
  const owners = await harness.query('SELECT group_id, truck_fleet, truck_owner, truck_source FROM driver_profiles ORDER BY group_id');
  assert.deepEqual(owners.rows.map((r) => [r.truck_fleet, r.truck_owner, r.truck_source]), [
    ['owner_operator', 'ERNST', 'board'], ['owner_operator', 'ROGER', 'board'],
  ]);
  assert.deepEqual(await openTrucks(harness), [
    ['JEROME JOYNER', '1', 'owner_operator', 'ERNST'],
    ['ROGER ALCIDE', '1', 'owner_operator', 'ROGER'],
  ]);
  const left = (await sweep()).findings.filter((f) => ['identity.truck_from_board', 'identity.unit_fleet_behind_profile'].includes(f.checkKey));
  assert.deepEqual(left, [], 'nothing left to propose');
});

test("a hired driver keeps his type; his truck becomes the owner's — and the copy reverts cleanly", { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { sweep, autoApply, resolver, revertCorrection } = bind(harness);
  const g = await chat(harness, {
    tg: -21, name: 'WENZE UNIT # 077 DAVID ONOBUN OLUGBENGA ( COMPANY )', first: 'DAVID ONOBUN', last: 'OLUGBENGA', unit: '077', type: 'company_driver',
  });
  const pg = (await resolver.ensurePersonForGroup(g)).personId;
  await resolver.syncUnitForPerson(pg, '077', { fleetType: 'company' });
  await boardLine(harness, { truckRaw: '077 (Polvan)', unit: '077', fleet: 'owner_operator', label: '(POLVAN)', driver: 'OLUGBENGA DAVID ONOBUN' });
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await sweep();
    // eslint-disable-next-line no-await-in-loop
    await autoApply();
  }
  const p = (await harness.query('SELECT driver_type, truck_fleet, truck_owner FROM driver_profiles WHERE group_id = $1', [g.id])).rows[0];
  assert.deepEqual(p, { driver_type: 'company_driver', truck_fleet: 'owner_operator', truck_owner: 'POLVAN' });
  assert.deepEqual(await openTrucks(harness), [['DAVID ONOBUN OLUGBENGA', '077', 'owner_operator', 'POLVAN']]);

  // Undo the profile copy — only the profile; the truck record has its own correction.
  const c = (await harness.query("SELECT id FROM operational_corrections WHERE action_key = 'identity.set_truck_from_board'")).rows[0];
  await revertCorrection({ correctionId: c.id, admin: { id: 1, username: 'admin', roleKeys: ['super_admin'], ip: null }, reason: 'undo' });
  const back = (await harness.query('SELECT truck_fleet, truck_owner, truck_source FROM driver_profiles WHERE group_id = $1', [g.id])).rows[0];
  assert.deepEqual(back, { truck_fleet: null, truck_owner: null, truck_source: null });
});

test('0093 sizes 0092\'s cap to the first pass — only while the row is still what 0092 wrote', { skip: skipWithoutPg() }, async (t) => {
  const fs = require('node:fs');
  const before = allMigrationsSql((name) => !name.startsWith('0093_'));
  const m0093 = fs.readFileSync(path.join(__dirname, '..', 'database', 'migrations', '0093_truck_owner_identity.sql'), 'utf8');
  const caps = async (harness) => Object.fromEntries((await harness.query(
    'SELECT check_key, max_auto_per_run, updated_by FROM operational_check_settings WHERE check_key LIKE \'identity.%\''
  )).rows.map((r) => [r.check_key, r]));

  const untouched = await createPgHarness(t, { extraDdl: before });
  assert.equal((await caps(untouched))['identity.unit_fleet_behind_profile'].max_auto_per_run, 20, '0092 as production has it');
  await untouched.query(m0093);
  await untouched.query(m0093); // idempotent: a second run changes nothing
  let r = await caps(untouched);
  assert.equal(r['identity.unit_fleet_behind_profile'].max_auto_per_run, 60);
  assert.match(r['identity.unit_fleet_behind_profile'].updated_by, /migration 0093/);
  assert.equal(r['identity.truck_from_board'].max_auto_per_run, 60);

  const saved = await createPgHarness(t, { extraDdl: before });
  await saved.query(
    "UPDATE operational_check_settings SET max_auto_per_run = 15, updated_by = 'admin:3' WHERE check_key = 'identity.unit_fleet_behind_profile'"
  );
  await saved.query(m0093);
  r = await caps(saved);
  assert.equal(r['identity.unit_fleet_behind_profile'].max_auto_per_run, 15, 'a cap a person saved is theirs');
  assert.equal(r['identity.unit_fleet_behind_profile'].updated_by, 'admin:3');
});
