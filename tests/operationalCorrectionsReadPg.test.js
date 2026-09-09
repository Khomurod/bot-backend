/**
 * Reading the correction trail.
 *
 * Stage 3 wrote `operational_corrections` and never read it back. The tests that
 * matter here are about honesty of the record rather than convenience of the
 * query: a correction outlives the finding that prompted it, a reverted one
 * still says it happened, and the tiles do not vanish when a count reaches zero.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

function load(harness) {
  return harness.loadDataLayer(['operationalCorrections', 'operationalFindings']);
}

async function harnessWith(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await harness.query(
    "INSERT INTO admins (id, username, password_hash) VALUES (1,'admin','x') ON CONFLICT DO NOTHING"
  );
  return harness;
}

async function insertCorrection(harness, {
  findingId = null, actionKey = 'home_time.close_cycle', subjectType = 'road_history',
  subjectId = '1', initiator = 'system', reverted = false, appliedAt = null,
} = {}) {
  const res = await harness.query(
    `INSERT INTO operational_corrections
       (finding_id, action_key, tier, subject_type, subject_id,
        old_values, new_values, initiator, applied_at, reverted_at, reverted_by)
     VALUES ($1,$2,'auto',$3,$4,
             '{"return_to_road_at": null}'::jsonb,
             '{"return_to_road_at": "2026-08-31T00:00:00Z"}'::jsonb,
             $5, COALESCE($6::timestamptz, NOW()),
             CASE WHEN $7::boolean THEN NOW() END,
             CASE WHEN $7::boolean THEN 'admin' END)
     RETURNING id`,
    [findingId, actionKey, subjectType, subjectId, initiator, appliedAt, reverted]
  );
  return res.rows[0].id;
}

test('a correction outlives the finding that prompted it', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { operationalCorrections: store, operationalFindings: findings } = load(harness);

  const finding = await findings.upsertFinding({
    checkKey: 'home_time.closable_open_cycle', subjectType: 'road_history', subjectId: 7,
    title: 'closable', severity: 'info', tier: 'auto',
  });
  const id = await insertCorrection(harness, { findingId: finding.id, subjectId: '7' });

  // Housekeeping removes the finding. ON DELETE SET NULL, not CASCADE.
  await harness.query('DELETE FROM operational_findings WHERE id = $1', [finding.id]);

  const rows = await store.listCorrections();
  assert.equal(rows.length, 1, 'a change actually made to the fleet must not vanish from history');
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].findingId, null);
  assert.equal(rows[0].findingTitle, null, 'the join is LEFT, so the row survives without it');
});

test('a correction carries its finding when it still has one', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { operationalCorrections: store, operationalFindings: findings } = load(harness);

  const finding = await findings.upsertFinding({
    checkKey: 'home_time.closable_open_cycle', subjectType: 'road_history', subjectId: 7,
    title: 'Cycle #7 can be closed from recorded evidence', severity: 'info', tier: 'auto',
  });
  await insertCorrection(harness, { findingId: finding.id, subjectId: '7' });

  const [row] = await store.listCorrections();
  assert.equal(row.checkKey, 'home_time.closable_open_cycle');
  assert.match(row.findingTitle, /can be closed/);
  assert.equal(row.findingSeverity, 'info');
});

test('a reverted correction still says it happened', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { operationalCorrections: store } = load(harness);
  await insertCorrection(harness, { subjectId: '1', reverted: true });
  await insertCorrection(harness, { subjectId: '2' });

  assert.equal((await store.listCorrections()).length, 2, 'the trail is append-only');
  const live = await store.listCorrections({ live: true });
  assert.deepEqual(live.map((c) => c.subjectId), ['2']);
  const undone = await store.listCorrections({ live: false });
  assert.deepEqual(undone.map((c) => c.subjectId), ['1']);
  assert.equal(undone[0].live, false);
  assert.ok(undone[0].revertedAt, 'the row is stamped, not deleted');
});

test('"what has been done to this driver" is one query', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { operationalCorrections: store } = load(harness);
  await insertCorrection(harness, { subjectType: 'group', subjectId: '42' });
  await insertCorrection(harness, { subjectType: 'group', subjectId: '99' });
  await insertCorrection(harness, { subjectType: 'road_history', subjectId: '42' });

  const rows = await store.listCorrections({ subjectType: 'group', subjectId: '42' });
  assert.equal(rows.length, 1, 'subject_id 42 on a different table is a different subject');
  assert.equal(rows[0].subjectType, 'group');
});

test('history is newest first', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { operationalCorrections: store } = load(harness);
  await insertCorrection(harness, { subjectId: 'old', appliedAt: '2026-01-01T00:00:00Z' });
  await insertCorrection(harness, { subjectId: 'new', appliedAt: '2026-09-01T00:00:00Z' });

  const rows = await store.listCorrections();
  assert.deepEqual(rows.map((c) => c.subjectId), ['new', 'old']);
});

test('the summary is zero-filled and splits system from human', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { operationalCorrections: store } = load(harness);

  const empty = await store.summariseCorrections();
  assert.deepEqual(empty, { total: 0, live: 0, reverted: 0, bySystem: 0, byAdmin: 0 },
    'a tile that vanishes at zero reads as broken, not as quiet');

  await insertCorrection(harness, { subjectId: '1' });
  await insertCorrection(harness, { subjectId: '2', reverted: true });
  await insertCorrection(harness, { subjectId: '3', initiator: 'admin:1', reverted: false });

  const s = await store.summariseCorrections();
  assert.deepEqual(s, { total: 3, live: 2, reverted: 1, bySystem: 2, byAdmin: 1 });
});

test('the audit log finally has a reader, scoped to corrections', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { operationalCorrections: store } = load(harness);
  const { insertAdminAudit } = harness.loadDataLayer(['adminAudit']).adminAudit;

  await insertAdminAudit({
    adminId: 1, roleKeys: ['super_admin'], action: 'operational_correction.home_time.close_cycle',
    entityType: 'road_history', entityId: 7, oldValues: {}, newValues: {},
  });
  // An unrelated edit to the same row must not be told as part of this story.
  await insertAdminAudit({
    adminId: 1, roleKeys: [], action: 'driver_profile.update',
    entityType: 'road_history', entityId: 7, oldValues: {}, newValues: {},
  });

  const rows = await store.listAuditForSubject({ entityType: 'road_history', entityId: 7 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'operational_correction.home_time.close_cycle');
  assert.equal(rows[0].username, 'admin', 'the actor is named, not just numbered');
});

test('the audit reader inherits the secret redactor', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { operationalCorrections: store } = load(harness);
  const { insertAdminAudit } = harness.loadDataLayer(['adminAudit']).adminAudit;

  await insertAdminAudit({
    adminId: 1, roleKeys: [], action: 'operational_correction.test',
    entityType: 'group', entityId: 5,
    oldValues: { api_key: 'super-secret-value', status: 'inactive' },
    newValues: { status: 'active' },
  });

  const [row] = await store.listAuditForSubject({ entityType: 'group', entityId: 5 });
  assert.equal(row.old_values.api_key, '[REDACTED]');
  assert.equal(row.old_values.status, 'inactive', 'only the secret is redacted');
});
