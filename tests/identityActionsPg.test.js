/**
 * The two person-layer corrections, and the sweep that files them — against a
 * real PostgreSQL.
 *
 * A correction is allowed to copy a fact already recorded. `identity.ensure_person`
 * copies the resolver's own decision for a chat nobody has texted in since the
 * layer arrived; `identity.sync_unit` copies the profile's truck onto the
 * person's record. Both must refuse on stale evidence and undo cleanly.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { POOL_PATH, purgeDataLayer } = require('./helpers/purgeDataLayer');

const ALL_MIGRATIONS = allMigrationsSql();
const SERVICE_PATHS = [
  '../services/identity/personResolver', '../services/identity/personBackfillService',
  '../services/operations/consistencyService', '../services/operations/corrections/actions',
  '../services/operations/corrections/identityActions', '../services/operations/corrections/alertActions',
  '../services/operations/corrections/apply', '../services/operations/corrections/autoApply',
].map((p) => path.resolve(__dirname, `${p}.js`));

/** Bind the data layer, the resolver and the correction machinery to the throwaway database. */
function bind(harness) {
  purgeDataLayer(SERVICE_PATHS);
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true,
    exports: { pool: harness.pool, query: harness.query, ping: async () => true },
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
      store, resolver,
      sweep: () => runConsistencySweep({ db, store }),
      applyCorrection: (a) => apply.applyCorrection({ ...a, db }),
      revertCorrection: (a) => apply.revertCorrection({ ...a, db }),
      autoApply: (o = {}) => autoApply.runAutoCorrections({ ...o, db, store }),
    };
  } finally {
    delete require.cache[POOL_PATH];
    purgeDataLayer(SERVICE_PATHS);
  }
}

async function seedGroup(harness, { telegramId, name, first, last, unit, active = true }) {
  const g = await harness.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type, active) VALUES ($1, $2, 'driver', $3) RETURNING *`,
    [telegramId, name, active]
  );
  await harness.query(
    `INSERT INTO driver_profiles (group_id, first_name, last_name, unit_number) VALUES ($1, $2, $3, $4)`,
    [g.rows[0].id, first, last, unit]
  );
  return g.rows[0];
}

async function harnessWith(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await harness.query("INSERT INTO admins (id, username, password_hash) VALUES (1,'admin','x') ON CONFLICT DO NOTHING");
  return harness;
}

const ADMIN = { id: 1, username: 'admin', roleKeys: ['super_admin'], ip: null };

test('the sweep files a finding for a placed-less group, and the correction places it and stamps its history', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { sweep, applyCorrection, revertCorrection, store } = bind(harness);
  const group = await seedGroup(harness, { telegramId: -1, name: 'WENZE UNIT # 27 RUSLAN ABDULLAEV', first: 'RUSLAN', last: 'ABDULLAEV', unit: '27' });
  await harness.query(`INSERT INTO home_time_requests (group_id, requested_at) VALUES ($1, NOW())`, [group.id]);

  const { findings } = await sweep();
  const finding = findings.find((f) => f.checkKey === 'identity.group_without_person');
  assert.ok(finding, 'the sweep notices a chat with no person');
  assert.equal(finding.subjectId, group.id);
  const filed = (await store.listFindings({ status: 'open', checkKey: 'identity.group_without_person' }))[0];
  assert.ok(filed);

  const correction = await applyCorrection({
    finding: filed, actionKey: 'identity.ensure_person', payload: { groupId: group.id },
    initiator: 'admin', admin: ADMIN, reason: 'test',
  });
  const personId = correction.new_values.personId;
  assert.ok(personId);
  const association = await harness.query('SELECT person_id FROM driver_person_groups WHERE group_id = $1 AND ended_at IS NULL', [group.id]);
  assert.equal(association.rows[0].person_id, personId);
  const request = await harness.query('SELECT person_id FROM home_time_requests WHERE group_id = $1', [group.id]);
  assert.equal(request.rows[0].person_id, personId, 'existing rows are stamped by the correction');

  // Applying again is stale, not a second person.
  await assert.rejects(
    applyCorrection({ finding: filed, actionKey: 'identity.ensure_person', payload: { groupId: group.id }, initiator: 'admin', admin: ADMIN }),
    (err) => err.stale === true || err.name === 'StaleCorrectionError'
  );

  await revertCorrection({ correctionId: correction.id, admin: ADMIN, reason: 'undo' });
  const after = await harness.query('SELECT COUNT(*)::int AS n FROM driver_person_groups WHERE group_id = $1 AND ended_at IS NULL', [group.id]);
  assert.equal(after.rows[0].n, 0, 'the association is closed');
  const unstamped = await harness.query('SELECT person_id FROM home_time_requests WHERE group_id = $1', [group.id]);
  assert.equal(unstamped.rows[0].person_id, null, 'and the stamp is lifted');
  const people = await harness.query('SELECT COUNT(*)::int AS n FROM driver_people');
  assert.equal(people.rows[0].n, 1, 'nothing is deleted — the person row stays, visible and harmless');
});

test("sync_unit brings the person's truck to the profile's; refuses when somebody else now holds it; reverts to the previous truck", { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { sweep, applyCorrection, revertCorrection, resolver, store } = bind(harness);
  const a = await seedGroup(harness, { telegramId: -1, name: 'WENZE UNIT # 322 SIROJIDDIN DAVUROV', first: 'SIROJIDDIN', last: 'DAVUROV', unit: '322' });
  const b = await seedGroup(harness, { telegramId: -2, name: 'WENZE UNIT # 001 OLABODE OLUDAISI', first: 'OLABODE', last: 'OLUDAISI', unit: '001' });
  const pa = (await resolver.ensurePersonForGroup(a.group ? a.group : a)).personId;
  const pb = (await resolver.ensurePersonForGroup(b)).personId;
  await resolver.syncUnitForPerson(pa, '320'); // the record is behind: profile says 322
  await resolver.syncUnitForPerson(pb, '001');

  const { findings } = await sweep();
  const stale = findings.filter((f) => f.checkKey === 'identity.stale_unit_assignment');
  assert.deepEqual(stale.map((f) => [f.subjectId, f.proposedChange.from, f.proposedChange.to]), [[a.id, '320', '322']]);
  const filed = (await store.listFindings({ status: 'open', checkKey: 'identity.stale_unit_assignment' }))[0];

  const correction = await applyCorrection({
    finding: filed, actionKey: 'identity.sync_unit',
    payload: { personId: pa, unitNumber: '322', groupId: a.id }, initiator: 'admin', admin: ADMIN,
  });
  let units = await harness.query('SELECT unit_number, ended_at IS NULL AS open FROM driver_units WHERE person_id = $1 ORDER BY started_at, id', [pa]);
  assert.deepEqual(units.rows.map((r) => [r.unit_number, r.open]), [['320', false], ['322', true]]);

  // B's profile now claims 322 too — held by A, so the registry refuses.
  await harness.query(`UPDATE driver_profiles SET unit_number = '322' WHERE group_id = $1`, [b.id]);
  await assert.rejects(
    applyCorrection({ finding: filed, actionKey: 'identity.sync_unit', payload: { personId: pb, unitNumber: '322', groupId: b.id }, initiator: 'admin', admin: ADMIN }),
    (err) => err.stale === true || err.name === 'StaleCorrectionError'
  );
  const contested = (await sweep()).findings.filter((f) => f.checkKey === 'identity.unit_contested');
  assert.deepEqual(contested.map((f) => f.subjectId), [b.id], 'and the sweep reports the contest for a person');

  await revertCorrection({ correctionId: correction.id, admin: ADMIN, reason: 'undo' });
  units = await harness.query('SELECT unit_number FROM driver_units WHERE person_id = $1 AND ended_at IS NULL', [pa]);
  assert.deepEqual(units.rows.map((r) => r.unit_number), ['320'], 'the previous truck is reopened as a new row');
});

test('the background loop places a group by itself once the check is enabled, and does nothing while it is off', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { sweep, autoApply } = bind(harness);
  const group = await seedGroup(harness, { telegramId: -1, name: 'WENZE UNIT # 12 QUIET DRIVER', first: 'QUIET', last: 'DRIVER', unit: '12' });
  await sweep();

  // Migration 0027 switches this check ON; an administrator switching it off
  // in Automation must be honoured on the very next pass.
  await harness.query(
    "UPDATE operational_check_settings SET auto_apply_enabled = FALSE, mode = 'suggest' WHERE check_key = 'identity.group_without_person'"
  );
  const off = await autoApply({ apply: true });
  assert.equal((await harness.query('SELECT COUNT(*)::int AS n FROM driver_person_groups')).rows[0].n, 0, 'switched off means off');
  assert.ok(off.summary);

  await harness.query(
    `INSERT INTO operational_check_settings (check_key, auto_apply_enabled, max_auto_per_run, mode)
     VALUES ('identity.group_without_person', TRUE, 50, 'autopilot')
     ON CONFLICT (check_key) DO UPDATE SET auto_apply_enabled = TRUE, mode = 'autopilot'`
  );
  const on = await autoApply({ apply: true });
  assert.equal(on.summary.applied, 1);
  const placed = await harness.query('SELECT person_id FROM driver_person_groups WHERE group_id = $1 AND ended_at IS NULL', [group.id]);
  assert.ok(placed.rows[0]?.person_id, 'the sweep placed the quiet driver without a message or a person');
  // The finding clears on the next sweep, so the board is honest.
  const { findings } = await sweep();
  assert.equal(findings.filter((f) => f.checkKey === 'identity.group_without_person').length, 0);
});

test('reverting ensure_person restores the associations it closed and lifts ONLY the stamps it wrote', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { applyCorrection, revertCorrection, resolver, store, sweep } = bind(harness);
  // A returning driver: the old chat holds person P and went inactive; the new
  // chat has no person yet.
  const old = await seedGroup(harness, { telegramId: -49, name: 'WENZE UNIT # 27 RUSLAN ABDULLAEV', first: 'RUSLAN', last: 'ABDULLAEV', unit: '27' });
  const personId = (await resolver.ensurePersonForGroup(old)).personId;
  await harness.query('UPDATE groups SET active = FALSE WHERE id = $1', [old.id]);
  const fresh = await seedGroup(harness, { telegramId: -541877, name: 'WENZE UNIT # 27 RUSLAN ABDULLAEV', first: 'RUSLAN', last: 'ABDULLAEV', unit: '27' });
  // One row on the new chat already names the person (written with the id);
  // one does not. Only the second may be touched by apply, and by revert.
  await harness.query(`INSERT INTO home_time_requests (group_id, person_id, requested_at) VALUES ($1, $2, NOW())`, [fresh.id, personId]);
  const blank = await harness.query(`INSERT INTO home_time_requests (group_id, requested_at) VALUES ($1, NOW()) RETURNING id`, [fresh.id]);

  await sweep();
  const filed = (await store.listFindings({ status: 'open', checkKey: 'identity.group_without_person' }))[0];
  const correction = await applyCorrection({
    finding: filed, actionKey: 'identity.ensure_person', payload: { groupId: fresh.id }, admin: ADMIN,
  });
  assert.equal(correction.new_values.personId, personId, 'the returning driver is the SAME person');
  const oldOpen = async () => (await harness.query(
    'SELECT COUNT(*)::int AS n FROM driver_person_groups WHERE group_id = $1 AND ended_at IS NULL', [old.id])).rows[0].n;
  assert.equal(await oldOpen(), 0, 'apply closed the old chat\'s association');

  await revertCorrection({ correctionId: correction.id, admin: ADMIN, reason: 'undo' });

  assert.equal(await oldOpen(), 1, 'revert reopened the association apply had closed');
  const newOpen = await harness.query('SELECT COUNT(*)::int AS n FROM driver_person_groups WHERE group_id = $1 AND ended_at IS NULL', [fresh.id]);
  assert.equal(newOpen.rows[0].n, 0);
  const rows = await harness.query('SELECT id, person_id FROM home_time_requests WHERE group_id = $1 ORDER BY id', [fresh.id]);
  assert.equal(rows.rows[0].person_id, personId, 'a row that already named the person is NOT touched by revert');
  assert.equal(rows.rows[1].id, blank.rows[0].id);
  assert.equal(rows.rows[1].person_id, null, 'the row apply stamped is the one revert lifts');
});

test('sync_unit carries the group\'s Samsara vehicle onto the new truck row, so the cross-system check still has both sides', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { applyCorrection, resolver, store, sweep } = bind(harness);
  const a = await seedGroup(harness, { telegramId: -1, name: 'WENZE UNIT # 322 SIROJIDDIN DAVUROV', first: 'SIROJIDDIN', last: 'DAVUROV', unit: '322' });
  await harness.query(`UPDATE groups SET samsara_vehicle_id = 'v-9' WHERE id = $1`, [a.id]);
  const pa = (await resolver.ensurePersonForGroup(a)).personId;
  await resolver.syncUnitForPerson(pa, '320');
  await sweep();
  const filed = (await store.listFindings({ status: 'open', checkKey: 'identity.stale_unit_assignment' }))[0];
  await applyCorrection({
    finding: filed, actionKey: 'identity.sync_unit', payload: { personId: pa, unitNumber: '322', groupId: a.id }, admin: ADMIN,
  });
  const open = await harness.query('SELECT unit_number, samsara_vehicle_id FROM driver_units WHERE person_id = $1 AND ended_at IS NULL', [pa]);
  assert.deepEqual(open.rows, [{ unit_number: '322', samsara_vehicle_id: 'v-9' }]);
});
