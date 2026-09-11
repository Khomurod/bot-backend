'use strict';

/**
 * The decision journal actually being written, by the thing that decides.
 *
 * WHAT ONLY A REAL DATABASE PROVES HERE: that a row lands in
 * `operational_decisions`. Every other test of this seam stubs `takeDecision`
 * and therefore proves the batch CALLS it — which is precisely the assertion
 * that would have passed for the whole life of the bug. `takeDecision` had
 * nineteen passing tests and no caller, so the journal was empty in
 * production, the verification pass graded nothing every hour and reported
 * healthy, and source reliability had no data and stayed decoration.
 *
 * So this walks the whole chain on real rows: a permitted, scored finding →
 * a decision row → an applied correction → the decision carrying the action
 * and the correction id the verification pass will later grade.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { takeDecision } = require('../services/decisions/journal');
const { clearReliabilityCache } = require('../services/decisions/journal');

const ALL_MIGRATIONS = allMigrationsSql();
const RETURNED_AT = '2026-08-31T00:00:00Z';

function loadModules(harness) {
  const db = { pool: harness.pool, query: harness.query };
  const layer = harness.loadDataLayer(['operationalFindings', 'operationalDecisions']);

  for (const p of [
    '../services/operations/corrections/actions',
    '../services/operations/corrections/apply',
    '../services/operations/corrections/autoApply',
  ]) delete require.cache[require.resolve(p)];

  const autoApply = require('../services/operations/corrections/autoApply');
  // The journal, bound to THIS database. Without this it writes through the
  // global pool, which in a test points at nothing — and the run would look
  // exactly like the bug being fixed.
  clearReliabilityCache();
  const deps = {
    takeDecision: (ask) => takeDecision(ask, { decisions: layer.operationalDecisions }),
  };
  return {
    db,
    store: layer.operationalFindings,
    decisions: layer.operationalDecisions,
    runAutoCorrections: (o = {}) => autoApply.runAutoCorrections({ ...o, db, store: layer.operationalFindings, deps }),
  };
}

async function harnessWith(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await harness.query(
    "INSERT INTO admins (id, username, password_hash) VALUES (1,'admin','x') ON CONFLICT DO NOTHING"
  );
  return harness;
}

async function seedGroup(harness) {
  const g = await harness.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type, active, status_source)
     VALUES (-9101,'WENZE UNIT # 27 A','driver',TRUE,'bot') RETURNING id`
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
     VALUES ($1,'2026-07-08T00:00:00Z','2026-08-25T00:00:00Z',48,100,NULL) RETURNING id`,
    [groupId]
  );
  await harness.query(
    `INSERT INTO driver_home_status (group_id, state, state_since, last_status_at)
     VALUES ($1,'road',$2,$2)
     ON CONFLICT (group_id) DO UPDATE SET state = 'road', state_since = EXCLUDED.state_since`,
    [groupId, RETURNED_AT]
  );
  return r.rows[0].id;
}

async function enable(harness, { shadow = false, mode = 'autopilot' } = {}) {
  await harness.query(
    `INSERT INTO operational_check_settings (check_key, auto_apply_enabled, mode, shadow)
     VALUES ('home_time.closable_open_cycle', $1, $2, $3)
     ON CONFLICT (check_key) DO UPDATE
       SET auto_apply_enabled = EXCLUDED.auto_apply_enabled,
           mode = EXCLUDED.mode, shadow = EXCLUDED.shadow`,
    [mode === 'autopilot', mode, shadow]
  );
}

async function fileFinding(store, cycleId, { confidence = 95 } = {}) {
  return store.upsertFinding({
    checkKey: 'home_time.closable_open_cycle',
    subjectType: 'road_history',
    subjectId: cycleId,
    title: 'closable',
    tier: 'auto',
    confidence,
    proposedChange: { id: cycleId, returnToRoadAt: { to: RETURNED_AT }, homeDays: { to: 6 } },
  });
}

// ── the row that was never written ───────────────────────────────────────────

test('AN APPLIED CORRECTION LEAVES A DECISION ROW — the journal was empty for its whole life',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const { runAutoCorrections, store } = loadModules(harness);
    const groupId = await seedGroup(harness);
    const cycleId = await seedOpenCycle(harness, groupId);
    await enable(harness);
    await fileFinding(store, cycleId);

    const { summary } = await runAutoCorrections({ apply: true });
    assert.equal(summary.applied, 1, 'the correction still happens — that comes first');

    const rows = (await harness.query('SELECT * FROM operational_decisions')).rows;
    assert.equal(rows.length, 1, 'and it is now on the record');
    const row = rows[0];
    assert.equal(row.check_key, 'home_time.closable_open_cycle');
    assert.equal(row.verdict, 'act');
    // 95 MINUS 10: one check observing something is one source, and nothing
    // corroborates it. The weighing is B3's, and this is the first evidence it
    // has ever run on a real correction — before this it had no caller to weigh
    // anything for. The margin matters: `home_time.returned_to_road` files at
    // 85 and lands at 75, five points above the floor.
    assert.equal(row.confidence, 85);
    assert.equal(row.mode, 'autopilot');
    assert.equal(row.shadow, false);
    assert.equal(row.subject_type, 'road_history');
    assert.equal(String(row.subject_id), String(cycleId));

    // WHY it was 85 travels with it, so a decision read back months later
    // explains itself rather than only stating a number.
    const evidence = typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence;
    assert.ok(evidence.weighing.some((r) => /nothing corroborates it/.test(r)),
      `expected the weighing to be recorded, got ${JSON.stringify(evidence.weighing)}`);
  });

test('and it carries the action and the correction the verification pass will grade',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const { runAutoCorrections, store } = loadModules(harness);
    const groupId = await seedGroup(harness);
    const cycleId = await seedOpenCycle(harness, groupId);
    await enable(harness);
    await fileFinding(store, cycleId);

    await runAutoCorrections({ apply: true });

    const row = (await harness.query('SELECT * FROM operational_decisions')).rows[0];
    assert.equal(row.action_key, 'home_time.close_cycle',
      'without this the grading pass has nothing to check the outcome of');
    assert.ok(row.correction_id, 'and the correction it produced');

    const correction = (await harness.query(
      'SELECT id FROM operational_corrections WHERE id = $1', [row.correction_id]
    )).rows[0];
    assert.ok(correction, 'which really exists');
  });

test('THE SOURCE IS RECORDED, which is the only thing that can ever make reliability real',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const { runAutoCorrections, store, decisions } = loadModules(harness);
    const groupId = await seedGroup(harness);
    const cycleId = await seedOpenCycle(harness, groupId);
    await enable(harness);
    await fileFinding(store, cycleId);

    await runAutoCorrections({ apply: true });

    // `sourceAgreement` is what `takeDecision` reads back to weigh evidence.
    // With no graded outcomes it is empty, and that is the correct starting
    // state — but the SOURCE has to be there for grading to have anything to
    // attach to later.
    const row = (await harness.query('SELECT sources FROM operational_decisions')).rows[0];
    const sources = Array.isArray(row.sources) ? row.sources : JSON.parse(row.sources || '[]');
    assert.equal(sources.length, 1);
    assert.equal(sources[0].source, 'check:home_time.closable_open_cycle');

    const agreement = await decisions.sourceAgreement({ sinceDays: 90 });
    assert.deepEqual(agreement, {},
      'nothing is graded yet, and an unmeasured source costs nothing');
  });

// ── a decision that does not act is still a decision ─────────────────────────

test('A HOLD IS RECORDED TOO — the rows nobody has another reason to write down',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const { runAutoCorrections, store } = loadModules(harness);
    const groupId = await seedGroup(harness);
    const cycleId = await seedOpenCycle(harness, groupId);
    await enable(harness);
    await fileFinding(store, cycleId, { confidence: null });

    const { summary } = await runAutoCorrections({ apply: true });
    assert.equal(summary.applied, 0);
    assert.equal(summary.held, 1);

    const row = (await harness.query('SELECT * FROM operational_decisions')).rows[0];
    assert.ok(row, 'the interesting decisions are exactly the ones that do nothing');
    assert.equal(row.verdict, 'unknown');
    assert.equal(row.confidence, null, 'and unknown carries no confidence at all');
    assert.equal(row.action_key, null, 'nothing was done');

    const cycle = (await harness.query(
      'SELECT return_to_road_at FROM driver_road_history WHERE id = $1', [cycleId]
    )).rows[0];
    assert.equal(cycle.return_to_road_at, null);
  });

test('SHADOW WRITES WHAT IT WOULD HAVE DONE, and changes nothing',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const { runAutoCorrections, store } = loadModules(harness);
    const groupId = await seedGroup(harness);
    const cycleId = await seedOpenCycle(harness, groupId);
    await enable(harness, { shadow: true });
    await fileFinding(store, cycleId);

    const { summary } = await runAutoCorrections({ apply: true });
    assert.equal(summary.applied, 0);
    assert.equal(summary.skipped.shadowed, 1);

    const row = (await harness.query('SELECT * FROM operational_decisions')).rows[0];
    assert.ok(row, 'the trial recorded something — a bare count was its whole output before');
    assert.equal(row.shadow, true);
    const would = typeof row.would_have === 'string' ? JSON.parse(row.would_have) : row.would_have;
    assert.equal(would.actionKey, 'home_time.close_cycle');

    const cycle = (await harness.query(
      'SELECT return_to_road_at FROM driver_road_history WHERE id = $1', [cycleId]
    )).rows[0];
    assert.equal(cycle.return_to_road_at, null, 'and the fleet is untouched');
  });

test('a check the owner has not enabled decides nothing at all',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const { runAutoCorrections, store } = loadModules(harness);
    const groupId = await seedGroup(harness);
    const cycleId = await seedOpenCycle(harness, groupId);
    await enable(harness, { mode: 'suggest' });
    await fileFinding(store, cycleId);

    const { summary } = await runAutoCorrections({ apply: true });
    assert.equal(summary.skipped.disabled, 1);

    const rows = (await harness.query('SELECT * FROM operational_decisions')).rows;
    assert.equal(rows.length, 0,
      'permission is checked before evidence — a check nobody switched on is not a decision');
  });
