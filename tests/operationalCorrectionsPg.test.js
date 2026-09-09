/**
 * Applying and reverting a correction, against a real PostgreSQL.
 *
 * This is the stage where software is allowed to change fleet data, so the
 * tests are mostly about what it must REFUSE to do: act without permission, act
 * on stale evidence, act at a scale that suggests it is broken, or act without
 * leaving a record a human can read and undo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

function loadModules(harness) {
  const db = { pool: harness.pool, query: harness.query };
  const store = harness.loadDataLayer(['operationalFindings']).operationalFindings;

  for (const p of [
    '../services/operations/corrections/actions',
    '../services/operations/corrections/apply',
    '../services/operations/corrections/autoApply',
  ]) delete require.cache[require.resolve(p)];

  const apply = require('../services/operations/corrections/apply');
  const autoApply = require('../services/operations/corrections/autoApply');
  return {
    db,
    store,
    applyCorrection: (a) => apply.applyCorrection({ ...a, db }),
    revertCorrection: (a) => apply.revertCorrection({ ...a, db }),
    runAutoCorrections: (o = {}) => autoApply.runAutoCorrections({ ...o, db, store }),
  };
}

async function seedGroup(harness, { telegramId = -9001, name = 'WENZE UNIT # 27 A', active = true, statusSource = 'bot' } = {}) {
  const g = await harness.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type, active, status_source)
     VALUES ($1,$2,'driver',$3,$4) RETURNING id`,
    [telegramId, name, active, statusSource]
  );
  const groupId = g.rows[0].id;
  await harness.query(
    `INSERT INTO driver_profiles (group_id, first_name, last_name, status)
     VALUES ($1,'A','ONE','inactive')`,
    [groupId]
  );
  return groupId;
}

async function seedOpenCycle(harness, groupId) {
  const r = await harness.query(
    `INSERT INTO driver_road_history
       (group_id, road_started_at, home_arrived_at, days_on_road, bonus_usd, return_to_road_at)
     VALUES ($1,'2026-07-08','2026-08-25',48,100,NULL) RETURNING id`,
    [groupId]
  );
  return r.rows[0].id;
}

async function harnessWith(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  // admin_audit_log.admin_id is a real FK to admins; in production the id comes
  // from the session, so it always exists. Seed the one the tests act as.
  await harness.query(
    "INSERT INTO admins (id, username, password_hash) VALUES (1,'admin','x') ON CONFLICT DO NOTHING"
  );
  return harness;
}

test('closing a cycle writes the correction, the audit row and nothing else', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { applyCorrection, store } = loadModules(harness);
  const groupId = await seedGroup(harness);
  const cycleId = await seedOpenCycle(harness, groupId);

  const finding = await store.upsertFinding({
    checkKey: 'home_time.closable_open_cycle', subjectType: 'road_history', subjectId: cycleId,
    title: 'closable', severity: 'info', tier: 'auto',
    proposedChange: { id: cycleId, returnToRoadAt: { from: null, to: '2026-08-31T00:00:00Z' }, homeDays: { from: null, to: 6 } },
  });

  const correction = await applyCorrection({
    actionKey: 'home_time.close_cycle',
    payload: { cycleId, returnToRoadAt: '2026-08-31T00:00:00Z', homeDays: 6 },
    finding,
  });

  const cycle = (await harness.query('SELECT * FROM driver_road_history WHERE id = $1', [cycleId])).rows[0];
  assert.ok(cycle.return_to_road_at);
  assert.equal(cycle.home_days, 6);
  assert.equal(Number(cycle.bonus_usd), 100, 'closing a cycle must be payout-neutral');

  assert.equal(correction.initiator, 'system');
  assert.deepEqual(correction.old_values, { return_to_road_at: null, home_days: null });

  const audit = await harness.query(
    "SELECT * FROM admin_audit_log WHERE action = 'operational_correction.home_time.close_cycle'"
  );
  assert.equal(audit.rows.length, 1, 'the audit log finally has a writer for this');
  assert.equal(audit.rows[0].entity_id, String(cycleId));

  assert.equal((await store.getFindingById(finding.id)).status, 'applied');
});

test('revert restores the before-image, is audited, and re-opens the finding', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { applyCorrection, revertCorrection, store } = loadModules(harness);
  const groupId = await seedGroup(harness);
  const cycleId = await seedOpenCycle(harness, groupId);

  const finding = await store.upsertFinding({
    checkKey: 'home_time.closable_open_cycle', subjectType: 'road_history', subjectId: cycleId,
    title: 'closable', tier: 'auto',
  });
  const correction = await applyCorrection({
    actionKey: 'home_time.close_cycle',
    payload: { cycleId, returnToRoadAt: '2026-08-31T00:00:00Z', homeDays: 6 },
    finding,
  });

  await revertCorrection({
    correctionId: correction.id,
    admin: { id: 1, username: 'admin', roleKeys: ['super_admin'] },
    reason: 'Wrong driver.',
  });

  const cycle = (await harness.query('SELECT * FROM driver_road_history WHERE id = $1', [cycleId])).rows[0];
  assert.equal(cycle.return_to_road_at, null, 'the before-image is restored exactly');
  assert.equal(cycle.home_days, null);

  const row = (await harness.query('SELECT * FROM operational_corrections WHERE id = $1', [correction.id])).rows[0];
  assert.ok(row.reverted_at, 'the original row is stamped, not deleted');
  assert.equal(row.reverted_by, 'admin');
  assert.equal(row.revert_reason, 'Wrong driver.');

  const audit = await harness.query(
    "SELECT * FROM admin_audit_log WHERE action LIKE 'operational_correction.revert.%'"
  );
  assert.equal(audit.rows.length, 1);

  assert.equal((await store.getFindingById(finding.id)).status, 'open', 'the condition is true again');
});

test('a correction cannot be reverted twice', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { applyCorrection, revertCorrection } = loadModules(harness);
  const groupId = await seedGroup(harness);
  const cycleId = await seedOpenCycle(harness, groupId);
  const c = await applyCorrection({
    actionKey: 'home_time.close_cycle',
    payload: { cycleId, returnToRoadAt: '2026-08-31T00:00:00Z', homeDays: 6 },
  });

  await revertCorrection({ correctionId: c.id, admin: { id: 1, username: 'admin' } });
  await assert.rejects(
    () => revertCorrection({ correctionId: c.id, admin: { id: 1, username: 'admin' } }),
    /already reverted/
  );
});

test('a cycle a human already closed is skipped, not overwritten', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { applyCorrection } = loadModules(harness);
  const groupId = await seedGroup(harness);
  const cycleId = await seedOpenCycle(harness, groupId);

  // Somebody fixed it by hand between the sweep and the apply.
  await harness.query(
    "UPDATE driver_road_history SET return_to_road_at = '2026-08-30', home_days = 5 WHERE id = $1",
    [cycleId]
  );

  await assert.rejects(
    () => applyCorrection({
      actionKey: 'home_time.close_cycle',
      payload: { cycleId, returnToRoadAt: '2026-08-31T00:00:00Z', homeDays: 6 },
    }),
    (err) => err.stale === true
  );

  const cycle = (await harness.query('SELECT home_days FROM driver_road_history WHERE id = $1', [cycleId])).rows[0];
  assert.equal(cycle.home_days, 5, "the person who got there first wins");
});

test('a status sync re-confirms the evidence inside the transaction', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { applyCorrection } = loadModules(harness);
  const groupId = await seedGroup(harness, { statusSource: 'bot' });

  // A human has since taken ownership of this group's status.
  await harness.query("UPDATE groups SET status_source = 'manual' WHERE id = $1", [groupId]);

  await assert.rejects(
    () => applyCorrection({
      actionKey: 'identity.sync_profile_status',
      payload: { groupId, toStatus: 'active' },
    }),
    (err) => err.stale === true && /not the bot/.test(err.message)
  );

  const profile = (await harness.query('SELECT status FROM driver_profiles WHERE group_id = $1', [groupId])).rows[0];
  assert.equal(profile.status, 'inactive', 'the system must not overrule a person');
});

test('the system cannot apply a non-auto action', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { db } = loadModules(harness);
  // The database is the backstop even if a caller forgets.
  await assert.rejects(
    () => db.query(
      `INSERT INTO operational_corrections (action_key, tier, subject_type, subject_id, initiator)
       VALUES ('x','approval','group','1','system')`
    ),
    /operational_corrections_system_is_auto_only/
  );
});

// ─── guardrails ──────────────────────────────────────────────────────────────

test('nothing auto-applies until a human enables that specific check', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { runAutoCorrections, store } = loadModules(harness);
  const groupId = await seedGroup(harness);
  const cycleId = await seedOpenCycle(harness, groupId);
  await store.upsertFinding({
    checkKey: 'home_time.closable_open_cycle', subjectType: 'road_history', subjectId: cycleId,
    title: 'closable', tier: 'auto',
    proposedChange: { id: cycleId, returnToRoadAt: { to: '2026-08-31T00:00:00Z' }, homeDays: { to: 6 } },
  });

  const { summary } = await runAutoCorrections({ apply: true });

  assert.equal(summary.applied, 0);
  assert.equal(summary.skipped.disabled, 1, 'default deny');
  const cycle = (await harness.query('SELECT return_to_road_at FROM driver_road_history WHERE id = $1', [cycleId])).rows[0];
  assert.equal(cycle.return_to_road_at, null);
});

test('a dry run returns the exact plan and writes nothing', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { runAutoCorrections, store } = loadModules(harness);
  const groupId = await seedGroup(harness);
  const cycleId = await seedOpenCycle(harness, groupId);
  await harness.query(
    "INSERT INTO operational_check_settings (check_key, auto_apply_enabled) VALUES ('home_time.closable_open_cycle', TRUE)"
  );
  await store.upsertFinding({
    checkKey: 'home_time.closable_open_cycle', subjectType: 'road_history', subjectId: cycleId,
    title: 'closable', tier: 'auto',
    proposedChange: { id: cycleId, returnToRoadAt: { to: '2026-08-31T00:00:00Z' }, homeDays: { to: 6 } },
  });

  const { summary, plan } = await runAutoCorrections({ apply: false });

  assert.equal(summary.dryRun, true);
  assert.equal(summary.eligible, 1);
  assert.equal(plan[0].actionKey, 'home_time.close_cycle');
  assert.match(plan[0].describe, /Close home-time cycle/);
  const n = await harness.query('SELECT COUNT(*)::int AS n FROM operational_corrections');
  assert.equal(n.rows[0].n, 0);
});

test('an enabled check applies, and only its own findings', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { runAutoCorrections, store } = loadModules(harness);
  const groupId = await seedGroup(harness);
  const cycleId = await seedOpenCycle(harness, groupId);
  await harness.query(
    "INSERT INTO operational_check_settings (check_key, auto_apply_enabled) VALUES ('home_time.closable_open_cycle', TRUE)"
  );
  await store.upsertFinding({
    checkKey: 'home_time.closable_open_cycle', subjectType: 'road_history', subjectId: cycleId,
    title: 'closable', tier: 'auto',
    proposedChange: { id: cycleId, returnToRoadAt: { to: '2026-08-31T00:00:00Z' }, homeDays: { to: 6 } },
  });
  // Enabled for cycles, NOT for status — this one must be left alone.
  await store.upsertFinding({
    checkKey: 'identity.status_disagreement', subjectType: 'group', subjectId: groupId,
    title: 'status', tier: 'auto',
    proposedChange: { groupId, field: 'status', from: 'inactive', to: 'active' },
  });

  const { summary } = await runAutoCorrections({ apply: true });

  assert.equal(summary.applied, 1);
  assert.equal(summary.skipped.disabled, 1);
  const profile = (await harness.query('SELECT status FROM driver_profiles WHERE group_id = $1', [groupId])).rows[0];
  assert.equal(profile.status, 'inactive', 'a check enabled for cycles grants nothing about status');
});

test('a check over its cap changes NOTHING and reports itself', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { runAutoCorrections, store } = loadModules(harness);
  await harness.query(
    "INSERT INTO operational_check_settings (check_key, auto_apply_enabled, max_auto_per_run) VALUES ('home_time.closable_open_cycle', TRUE, 2)"
  );
  const groupId = await seedGroup(harness);
  for (let i = 0; i < 3; i += 1) {
    const cycleId = await seedOpenCycle(harness, groupId);
    await store.upsertFinding({
      checkKey: 'home_time.closable_open_cycle', subjectType: 'road_history', subjectId: cycleId,
      title: `closable ${i}`, tier: 'auto',
      proposedChange: { id: cycleId, returnToRoadAt: { to: '2026-08-31T00:00:00Z' }, homeDays: { to: 6 } },
    });
  }

  const { summary, capped } = await runAutoCorrections({ apply: true });

  assert.equal(summary.applied, 0, 'wanting 3 with a cap of 2 applies zero, not two');
  assert.deepEqual(capped, [{ checkKey: 'home_time.closable_open_cycle', wanted: 3, cap: 2 }]);

  const selfReport = await store.listFindings({ checkKey: 'operations.auto_apply_capped' });
  assert.equal(selfReport.length, 1, 'the stall is visible, not silent');
  assert.equal(selfReport[0].severity, 'serious');
});
