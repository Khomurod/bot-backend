/**
 * The Home Time repair, at production scale, against a real PostgreSQL.
 *
 * Production carries 74 open cycles out of 79. Classified by the evidence
 * available to close them:
 *
 *   38 class A — the group's current state is `road`, since a moment AFTER this
 *                cycle's home arrival. That timestamp IS the observed return.
 *   27 class B — a LATER cycle exists for the same group, so that row's
 *                `road_started_at` is this cycle's return seen from the far side.
 *                These are the structurally unreachable ones: `getOpenHomeStay`
 *                is LIMIT 1, so normal operation can never close them.
 *    9 class C — the driver really is still at home. Correctly open.
 *    0 class N — nothing requires invention.
 *
 * This file seeds exactly that shape and asserts the repair closes **65 and only
 * 65**, leaves the 9 alone, and is reversible row by row. It is the closest
 * thing to a rehearsal that exists without production credentials — and it is
 * what makes the number 65 a claim about behaviour rather than a memory.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { classifyOpenCycles } = require('../services/operations/checks/homeTime');

const ALL_MIGRATIONS = allMigrationsSql();

const CLASS_A = 38;
const CLASS_B = 27;
const CLASS_C = 9;
const CLOSABLE = CLASS_A + CLASS_B; // 65

async function harnessWith(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await harness.query(
    "INSERT INTO admins (id, username, password_hash) VALUES (1,'admin','x') ON CONFLICT DO NOTHING"
  );
  // Migration 0027 also switches on the two identity checks. This file binds
  // only the corrections engine to the harness, not the identity layer's data
  // modules (tests/identityActionsPg.test.js does that), so those checks are
  // switched off here the way an administrator would — through their row.
  await harness.query("UPDATE operational_check_settings SET auto_apply_enabled = FALSE, mode = 'suggest' WHERE check_key LIKE 'identity.%'");
  return harness;
}

async function seedGroup(harness, n) {
  const res = await harness.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type, active, status_source)
     VALUES ($1, $2, 'driver', TRUE, 'bot') RETURNING id`,
    [-100000 - n, `WENZE UNIT # ${100 + n} DRIVER`]
  );
  return res.rows[0].id;
}

const iso = (day) => `2026-06-${String(day).padStart(2, '0')}T00:00:00Z`;

/**
 * Build the production shape.
 *
 * Each class gets its own groups so the three cases cannot contaminate each
 * other — a class-B group has two cycles, a class-A group has one plus a `road`
 * status, a class-C group has one plus a `home` status.
 */
async function seedProductionShape(harness) {
  let n = 0;

  for (let i = 0; i < CLASS_A; i += 1) {
    const groupId = await seedGroup(harness, n += 1);
    await harness.query(
      `INSERT INTO driver_road_history (group_id, road_started_at, home_arrived_at, days_on_road, bonus_usd)
       VALUES ($1, $2, $3, 30, 100)`,
      [groupId, iso(1), iso(10)]
    );
    // Observed back on the road on the 20th — the evidence.
    await harness.query(
      `INSERT INTO driver_home_status (group_id, state, state_since, last_status_at)
       VALUES ($1, 'road', $2, $2)`,
      [groupId, iso(20)]
    );
  }

  for (let i = 0; i < CLASS_B; i += 1) {
    const groupId = await seedGroup(harness, n += 1);
    // The older cycle, left open — unreachable by normal operation.
    await harness.query(
      `INSERT INTO driver_road_history (group_id, road_started_at, home_arrived_at, days_on_road, bonus_usd)
       VALUES ($1, $2, $3, 30, 100)`,
      [groupId, iso(1), iso(5)]
    );
    // The later cycle: its road start is the older cycle's return.
    await harness.query(
      `INSERT INTO driver_road_history
         (group_id, road_started_at, home_arrived_at, days_on_road, bonus_usd, return_to_road_at)
       VALUES ($1, $2, $3, 20, 100, $4)`,
      [groupId, iso(12), iso(25), iso(28)]
    );
    await harness.query(
      `INSERT INTO driver_home_status (group_id, state, state_since, last_status_at)
       VALUES ($1, 'road', $2, $2)`,
      [groupId, iso(28)]
    );
  }

  for (let i = 0; i < CLASS_C; i += 1) {
    const groupId = await seedGroup(harness, n += 1);
    await harness.query(
      `INSERT INTO driver_road_history (group_id, road_started_at, home_arrived_at, days_on_road, bonus_usd)
       VALUES ($1, $2, $3, 30, 100)`,
      [groupId, iso(1), iso(10)]
    );
    // Genuinely still at home. Nothing to close.
    await harness.query(
      `INSERT INTO driver_home_status (group_id, state, state_since, last_status_at)
       VALUES ($1, 'home', $2, $2)`,
      [groupId, iso(10)]
    );
  }
}

/**
 * Migration 0027 seeds this check ON with cap 65, so a test that wants another
 * state must say so explicitly — an INSERT would collide with the seed.
 */
async function allowRepair(harness, cap) {
  await harness.query(
    `INSERT INTO operational_check_settings (check_key, auto_apply_enabled, max_auto_per_run, mode)
     VALUES ('home_time.closable_open_cycle', TRUE, $1, 'autopilot')
     ON CONFLICT (check_key) DO UPDATE SET auto_apply_enabled = TRUE, mode = 'autopilot', max_auto_per_run = EXCLUDED.max_auto_per_run`,
    [cap]
  );
}

function loadOps(harness) {
  const db = { pool: harness.pool, query: harness.query };
  const store = harness.loadDataLayer(['operationalFindings']).operationalFindings;
  for (const p of [
    '../services/operations/consistencyService',
    '../services/operations/corrections/actions',
    '../services/operations/corrections/apply',
    '../services/operations/corrections/autoApply',
  ]) delete require.cache[require.resolve(p)];
  const { runConsistencySweep } = require('../services/operations/consistencyService');
  const { runAutoCorrections } = require('../services/operations/corrections/autoApply');
  const { revertCorrection } = require('../services/operations/corrections/apply');
  return {
    db,
    store,
    sweep: () => runConsistencySweep({ db, store }),
    preview: () => runAutoCorrections({ apply: false, db, store }),
    apply: () => runAutoCorrections({ apply: true, db, store }),
    revert: (id, admin) => revertCorrection({ correctionId: id, admin, db }),
  };
}

const openCount = async (harness) => (await harness.query(
  'SELECT COUNT(*)::int AS n FROM driver_road_history WHERE return_to_road_at IS NULL'
)).rows[0].n;

// ─── the classification, on the real shape ───────────────────────────────────

test('the production shape classifies 38 A / 27 B / 9 C / 0 N', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  await seedProductionShape(harness);

  const roadHistory = (await harness.query(
    `SELECT id, group_id, road_started_at, home_arrived_at, return_to_road_at, home_days
       FROM driver_road_history ORDER BY group_id, home_arrived_at`
  )).rows;
  const homeStatus = (await harness.query(
    'SELECT group_id, state, state_since FROM driver_home_status'
  )).rows;

  const tally = { A: 0, B: 0, C: 0, N: 0 };
  for (const v of classifyOpenCycles({ roadHistory, homeStatus })) tally[v.evidenceClass] += 1;

  assert.deepEqual(tally, { A: CLASS_A, B: CLASS_B, C: CLASS_C, N: 0 },
    'zero class N is the claim that nothing requires invention');
});

// ─── the repair ──────────────────────────────────────────────────────────────

test('the repair closes 65 and only 65', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  await seedProductionShape(harness);
  const ops = loadOps(harness);

  await ops.sweep();
  assert.equal(await openCount(harness), CLOSABLE + CLASS_C);

  // The cap is the trap: 65 > the default 50, so the check reports itself
  // capped and applies NOTHING. Raising it is part of the repair, not an
  // afterthought.
  await allowRepair(harness, 100);

  const { summary } = await ops.apply();

  assert.equal(summary.applied, CLOSABLE, 'exactly the closable ones');
  assert.equal(summary.failed, 0);
  assert.equal(await openCount(harness), CLASS_C,
    'the 9 drivers who really are at home stay open');
});

test('with migration 0027\'s seed alone, the background pass closes exactly 65', { skip: skipWithoutPg() }, async (t) => {
  // This is the production path: no admin clicks anything, the settings row is
  // the migration's, and the first background pass after deploy does the repair.
  const harness = await harnessWith(t);
  await seedProductionShape(harness);
  const ops = loadOps(harness);
  await ops.sweep();
  const setting = await harness.query(
    "SELECT auto_apply_enabled, max_auto_per_run FROM operational_check_settings WHERE check_key = 'home_time.closable_open_cycle'"
  );
  assert.deepEqual(setting.rows[0], { auto_apply_enabled: true, max_auto_per_run: CLOSABLE }, 'the seed, untouched');

  const { summary, capped } = await ops.apply();
  assert.equal(summary.applied, CLOSABLE);
  assert.deepEqual(capped, []);
  assert.equal(await openCount(harness), CLASS_C);
});

test('one cycle more than measured and the seeded cap stops the whole batch', { skip: skipWithoutPg() }, async (t) => {
  // The cap is exactly the measured 65 so that a fleet that no longer matches
  // the measurement is refused, not repaired a little wider.
  const harness = await harnessWith(t);
  await seedProductionShape(harness);
  const extra = await seedGroup(harness, 999);
  await harness.query(
    `INSERT INTO driver_road_history (group_id, road_started_at, home_arrived_at, days_on_road, bonus_usd)
     VALUES ($1, $2, $3, 30, 100)`,
    [extra, iso(1), iso(10)]
  );
  await harness.query(
    `INSERT INTO driver_home_status (group_id, state, state_since, last_status_at) VALUES ($1, 'road', $2, $2)`,
    [extra, iso(20)]
  );
  const ops = loadOps(harness);
  await ops.sweep();

  const { summary, capped } = await ops.apply();
  assert.equal(summary.applied, 0, 'nothing is applied — not 65 of 66');
  assert.deepEqual(capped, [{ checkKey: 'home_time.closable_open_cycle', wanted: CLOSABLE + 1, cap: CLOSABLE }]);
  assert.equal(await openCount(harness), CLOSABLE + 1 + CLASS_C, 'every row is exactly as it was');
});

test('the default cap of 50 silently blocks a 65-row repair', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  await seedProductionShape(harness);
  const ops = loadOps(harness);
  await ops.sweep();

  // Enabled, but at the schema's default cap of 50 — the state a fleet without
  // migration 0027's seed would be in.
  await allowRepair(harness, 50);

  const { summary, capped } = await ops.preview();

  assert.equal(summary.eligible, 0,
    'a capped check reports eligible: 0 — identical to "found nothing", which is the trap');
  assert.deepEqual(capped, [{ checkKey: 'home_time.closable_open_cycle', wanted: CLOSABLE, cap: 50 }]);
});

test('the repair is payout-neutral', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  await seedProductionShape(harness);
  const ops = loadOps(harness);
  await ops.sweep();
  await allowRepair(harness, 100);

  const before = (await harness.query('SELECT COALESCE(SUM(bonus_usd),0)::int AS t FROM driver_road_history')).rows[0].t;
  await ops.apply();
  const after = (await harness.query('SELECT COALESCE(SUM(bonus_usd),0)::int AS t FROM driver_road_history')).rows[0].t;

  assert.equal(after, before, 'closing a cycle must not move a single dollar');
});

test('every closed cycle records the evidence class that justified it', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  await seedProductionShape(harness);
  const ops = loadOps(harness);
  await ops.sweep();

  const findings = await ops.store.listFindings({
    checkKey: 'home_time.closable_open_cycle', limit: 200,
  });
  assert.equal(findings.length, CLOSABLE);

  const classes = findings.reduce((acc, f) => {
    acc[f.evidence.evidenceClass] = (acc[f.evidence.evidenceClass] || 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(classes, { A: CLASS_A, B: CLASS_B });
  assert.equal(findings.filter((f) => f.evidence.hiddenByLaterCycle).length, CLASS_B,
    'class B rows are flagged as structurally unreachable — that is why they need this');
});

test('a repaired cycle can be undone, one row at a time', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  await seedProductionShape(harness);
  const ops = loadOps(harness);
  await ops.sweep();
  await allowRepair(harness, 100);
  await ops.apply();
  assert.equal(await openCount(harness), CLASS_C);

  const corrections = (await harness.query(
    'SELECT id, subject_id FROM operational_corrections ORDER BY id LIMIT 3'
  )).rows;
  for (const c of corrections) {
    await ops.revert(c.id, { id: 1, username: 'admin', roleKeys: [] });
  }

  assert.equal(await openCount(harness), CLASS_C + corrections.length,
    'a repair nobody can undo is not one anybody should run');
});

test('re-running the repair is a no-op, not a second pass', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  await seedProductionShape(harness);
  const ops = loadOps(harness);
  await ops.sweep();
  await allowRepair(harness, 100);
  await ops.apply();

  await ops.sweep();
  const second = await ops.apply();

  assert.equal(second.summary.applied, 0);
  assert.equal(await openCount(harness), CLASS_C);
  const total = (await harness.query('SELECT COUNT(*)::int AS n FROM operational_corrections')).rows[0].n;
  assert.equal(total, CLOSABLE, 'no duplicate corrections were recorded');
});
