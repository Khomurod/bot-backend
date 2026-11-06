/**
 * A change the owner typed and then confirmed, against a real PostgreSQL:
 * `executeOffered` applies the change stored on the question's Yes through the
 * correction registry as the owner, leaves the finding for the sweep (put aside,
 * not marked applied), refuses a stale Yes, and reverts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { POOL_PATH, purgeDataLayer } = require('./helpers/purgeDataLayer');
const { validateProposal } = require('../lib/control/changeCatalogue');

const ALL_MIGRATIONS = allMigrationsSql();
const SERVICE_PATHS = [
  '../services/control/actions', '../services/operations/corrections/apply', '../services/operations/corrections/actions',
  '../services/operations/corrections/profileEditActions', '../services/decisions/journal',
].map((p) => path.resolve(__dirname, `${p}.js`));

function bind(harness) {
  purgeDataLayer(SERVICE_PATHS);
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true, exports: { pool: harness.pool, query: harness.query, ping: async () => true },
  };
  try {
    const db = { pool: harness.pool, query: harness.query };
    const actions = require('../services/control/actions');
    const apply = require('../services/operations/corrections/apply');
    const deps = { ...actions.defaultDeps(), applyCorrection: (a) => apply.applyCorrection({ ...a, db }) };
    return {
      execute: (args) => actions.executeOffered(args, deps),
      revert: (a) => apply.revertCorrection({ ...a, db }),
    };
  } finally {
    delete require.cache[POOL_PATH];
    purgeDataLayer(SERVICE_PATHS);
  }
}

async function seed(harness) {
  await harness.query("INSERT INTO admins (id, username, password_hash) VALUES (1,'admin','x') ON CONFLICT DO NOTHING");
  const g = (await harness.query(
    "INSERT INTO groups (telegram_group_id, group_name, group_type, active) VALUES (-347, 'WENZE UNIT # 01 JOHN / MARK', 'driver', TRUE) RETURNING id"
  )).rows[0].id;
  await harness.query(
    "INSERT INTO driver_profiles (group_id, first_name, unit_number, driver_type) VALUES ($1, 'JOHN', '01', 'owner')", [g]
  );
  const f = (await harness.query(
    `INSERT INTO operational_findings (check_key, subject_type, subject_id, title, severity, tier)
     VALUES ('fleet.driver_not_in_wenze', 'board_truck', '1 RUDOLPH', 't', 'warning', 'warning') RETURNING *`
  )).rows[0];
  return { g, finding: { id: f.id, checkKey: f.check_key, subjectType: f.subject_type, subjectId: f.subject_id, title: f.title, evidence: {} } };
}

const target = (g, current) => ({ letter: 'A', groupId: g, groupName: 'WENZE UNIT # 01 JOHN / MARK', current });
const questionWith = (change) => ({
  offeredActions: [{ key: 'approve', label: 'yes', change }, { key: 'dismiss', label: 'no', rejectsChange: true }],
});
const unitOf = async (h, g) => (await h.query('SELECT unit_number FROM driver_profiles WHERE group_id = $1', [g])).rows[0].unit_number;

test('Yes to "unit 01 → 1": applied as the owner, finding put aside for the sweep, and undone', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { execute, revert } = bind(h);
  const { g, finding } = await seed(h);
  const { change } = validateProposal({ operation: 'set_unit', target: 'A', values: { unit_number: '1' } }, [target(g, { unitNumber: '01' })]);

  const got = await execute({ question: questionWith(change), finding, intent: { action: 'approve' }, telegramUserId: '2117922421' });
  assert.equal(got.outcome, 'applied', got.message);
  assert.equal(await unitOf(h, g), '1');
  const c = (await h.query('SELECT id, action_key, initiator, tier FROM operational_corrections')).rows[0];
  assert.deepEqual([c.action_key, c.initiator, c.tier], ['profile.set_unit', 'telegram:2117922421', 'approval']);
  const f = (await h.query('SELECT status, snoozed_until FROM operational_findings WHERE id = $1', [finding.id])).rows[0];
  assert.equal(f.status, 'open', 'whether it settled the question is the next sweep\'s to say');
  assert.ok(f.snoozed_until, 'put aside until then');

  await revert({ correctionId: c.id, admin: { id: 1, username: 'admin', roleKeys: ['super_admin'], ip: null }, reason: 'undo' });
  assert.equal(await unitOf(h, g), '01');
});

test('a Yes to a question the records have moved past changes nothing', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { execute } = bind(h);
  const { g, finding } = await seed(h);
  const { change } = validateProposal({ operation: 'set_unit', target: 'A', values: { unit_number: '1' } }, [target(g, { unitNumber: '01' })]);
  await h.query("UPDATE driver_profiles SET unit_number = '7' WHERE group_id = $1", [g]); // somebody edited it since

  const got = await execute({ question: questionWith(change), finding, intent: { action: 'approve' }, telegramUserId: '2117922421' });
  assert.equal(got.outcome, 'no_op');
  assert.equal(await unitOf(h, g), '7');
  assert.equal((await h.query('SELECT count(*)::int n FROM operational_corrections')).rows[0].n, 0);
});

test('Yes to "the truck is RUDOLPH\'s": recorded by hand, so the board copy never overwrites it', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { execute, revert } = bind(h);
  const { g, finding } = await seed(h);
  const { change } = validateProposal({ operation: 'set_truck', target: 'A', values: { fleet: 'owner_operator', owner: 'Rudolph' } }, [target(g, {})]);

  const got = await execute({ question: questionWith(change), finding, intent: { action: 'approve' }, telegramUserId: '2117922421' });
  assert.equal(got.outcome, 'applied', got.message);
  const p = (await h.query('SELECT truck_fleet, truck_owner, truck_source FROM driver_profiles WHERE group_id = $1', [g])).rows[0];
  assert.deepEqual(p, { truck_fleet: 'owner_operator', truck_owner: 'RUDOLPH', truck_source: 'manual' });
  const c = (await h.query('SELECT id FROM operational_corrections')).rows[0];
  await revert({ correctionId: c.id, admin: { id: 1, username: 'admin', roleKeys: ['super_admin'], ip: null }, reason: 'undo' });
  const back = (await h.query('SELECT truck_fleet, truck_owner, truck_source FROM driver_profiles WHERE group_id = $1', [g])).rows[0];
  assert.deepEqual(back, { truck_fleet: null, truck_owner: null, truck_source: null });
});
