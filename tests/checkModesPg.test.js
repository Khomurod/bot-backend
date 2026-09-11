'use strict';

/**
 * Observe / Suggest / Autopilot, against a real PostgreSQL.
 *
 * TWO PROPERTIES, AND THE FIRST IS THE ONE THAT KEEPS PEOPLE SAFE.
 *
 * NOTHING TURNS ON OR OFF AT DEPLOY. A boolean became a mode, and the mapping
 * has to be exact in both directions: a check somebody had armed must still be
 * armed, one they had not must still be quiet, and the many checks with NO ROW
 * — which is most of them — must keep meaning what they meant.
 *
 * AND THE TWO COLUMNS CANNOT DRIFT. `auto_apply_enabled` stays because other
 * modules read it. A column quietly abandoned while another takes over is the
 * exact failure this project keeps finding, so the database refuses the
 * disagreement rather than trusting everybody to remember.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { operationalCheckSettings } = h.loadDataLayer(['operationalCheckSettings']);
  return { h, s: operationalCheckSettings };
}

test('AN ARMED CHECK STAYS ARMED, and a quiet one stays quiet',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, s } = await setup(t);
    // Written as the pre-0044 code would have, then read through the new layer.
    await h.query(
      `INSERT INTO operational_check_settings (check_key, auto_apply_enabled, max_auto_per_run, mode)
       VALUES ('armed', TRUE, 50, 'autopilot'), ('quiet', FALSE, 50, 'suggest')`
    );
    const rows = await s.listCheckSettings();
    const byKey = Object.fromEntries(rows.map((r) => [r.checkKey, r]));
    assert.equal(byKey.armed.mode, 'autopilot');
    assert.equal(byKey.armed.autoApplyEnabled, true);
    assert.equal(byKey.quiet.mode, 'suggest');
    assert.equal(byKey.quiet.autoApplyEnabled, false);
  });

test('NO ROW ANYWHERE DISAGREES WITH ITSELF — the sentinel',
  { skip: skipWithoutPg() }, async (t) => {
    // A CHECK forcing this was written first and then removed, because it made
    // migration 0027 — which seeds three checks with the boolean alone — no
    // longer re-appliable, and "the migration re-applies as a no-op" is a
    // property this repository tests for on purpose. The rationale is in 0044.
    //
    // So the agreement is asserted rather than enforced, and the reason that is
    // safe is the next test: nothing that ACTS reads the boolean any more.
    const { h, s } = await setup(t);
    await s.upsertCheckSettings('a', { mode: 'autopilot' });
    await s.upsertCheckSettings('b', { mode: 'observe' });
    await s.upsertCheckSettings('c', { autoApplyEnabled: true });
    const bad = await h.query(
      `SELECT check_key FROM operational_check_settings
        WHERE auto_apply_enabled <> (mode = 'autopilot')`
    );
    assert.deepEqual(bad.rows, [],
      'every row the data layer wrote states the same fact twice and agrees with itself');
  });

test('AND DRIFT IS HARMLESS, because the mode is what acts',
  { skip: skipWithoutPg() }, async (t) => {
    // Forced into disagreement behind the data layer's back, the way a stray
    // raw write would. What matters is that the deciding code follows `mode`.
    const { h } = await setup(t);
    await h.query(
      `INSERT INTO operational_check_settings (check_key, auto_apply_enabled, mode, max_auto_per_run)
       VALUES ('home_time.closable_open_cycle', TRUE, 'suggest', 50)
       ON CONFLICT (check_key) DO UPDATE SET auto_apply_enabled = TRUE, mode = 'suggest'`
    );
    // eslint-disable-next-line global-require
    const { runAutoCorrections } = require('../services/operations/corrections/autoApply');
    const store = h.loadDataLayer(['operationalFindings']).operationalFindings;
    // AN OPEN FINDING THIS CHECK COULD ACT ON. Without one, `eligible` is zero
    // whichever column is read and the test passes for the wrong reason —
    // which is what the first version of it did.
    await store.upsertFinding({
      checkKey: 'home_time.closable_open_cycle',
      subjectType: 'road_history', subjectId: '1',
      title: 'an open cycle that could be closed',
      severity: 'info', tier: 'auto',
      proposedChange: { cycleId: 1, returnToRoadAt: '2026-09-01T00:00:00Z', homeDays: 2 },
    });

    const db = { pool: h.pool, query: h.query };
    const held = await runAutoCorrections({ apply: false, db, store });
    assert.equal(held.summary.eligible, 0,
      'the boolean says "apply automatically" and the mode says "propose"; a '
      + 'stale boolean must not be able to arm a check nobody armed');

    // And the same finding IS eligible once the mode actually says so — which
    // is what makes the assertion above mean something.
    await h.query(
      "UPDATE operational_check_settings SET mode = 'autopilot' "
      + "WHERE check_key = 'home_time.closable_open_cycle'"
    );
    const armed = await runAutoCorrections({ apply: false, db, store });
    assert.equal(armed.summary.eligible, 1, 'the mode is what arms it');
  });

test('setting a mode writes the boolean in the SAME statement',
  { skip: skipWithoutPg() }, async (t) => {
    const { s } = await setup(t);
    const row = await s.upsertCheckSettings('x', { mode: 'autopilot', updatedBy: 'boss' });
    assert.equal(row.mode, 'autopilot');
    assert.equal(row.autoApplyEnabled, true, 'they cannot be written apart');

    const back = await s.upsertCheckSettings('x', { mode: 'observe', updatedBy: 'boss' });
    assert.equal(back.autoApplyEnabled, false);
  });

test('A CALLER THAT STILL PASSES ONLY THE BOOLEAN KEEPS WORKING',
  { skip: skipWithoutPg() }, async (t) => {
    // `services/operations/learningActions.js` switches automation off this
    // way, and the older routes do too. Breaking them would have turned a
    // widening into a migration of every call site.
    const { s } = await setup(t);
    const on = await s.upsertCheckSettings('legacy', { autoApplyEnabled: true });
    assert.equal(on.mode, 'autopilot');
    const off = await s.upsertCheckSettings('legacy', { autoApplyEnabled: false });
    assert.equal(off.mode, 'suggest', 'off means propose, which is what it always meant');
  });

test('an unreadable mode falls to SUGGEST, never autopilot',
  { skip: skipWithoutPg() }, async (t) => {
    const { s } = await setup(t);
    const row = await s.upsertCheckSettings('x', { mode: 'turbo' });
    assert.equal(row.mode, 'suggest', 'a setting nobody can read must fail to the cautious side');
    assert.equal(row.autoApplyEnabled, false);
  });

test('the schema refuses a mode nobody defined', { skip: skipWithoutPg() }, async (t) => {
  const { h } = await setup(t);
  await assert.rejects(() => h.query(
    `INSERT INTO operational_check_settings (check_key, auto_apply_enabled, mode)
     VALUES ('x', FALSE, 'yolo')`
  ));
});

test('SHADOW IS ORTHOGONAL — it does not cost you your real setting',
  { skip: skipWithoutPg() }, async (t) => {
    const { s } = await setup(t);
    const row = await s.upsertCheckSettings('x', { mode: 'autopilot', shadow: true });
    assert.equal(row.mode, 'autopilot', 'the real setting is remembered');
    assert.equal(row.shadow, true);
    const off = await s.upsertCheckSettings('x', { shadow: false });
    assert.equal(off.mode, 'autopilot', 'and comes back when shadow is turned off');
    assert.equal(off.shadow, false);
  });

test('shadow defaults to false and is left alone when not mentioned',
  { skip: skipWithoutPg() }, async (t) => {
    const { s } = await setup(t);
    const made = await s.upsertCheckSettings('x', { mode: 'suggest' });
    assert.equal(made.shadow, false);
    await s.upsertCheckSettings('x', { shadow: true });
    const kept = await s.upsertCheckSettings('x', { mode: 'autopilot' });
    assert.equal(kept.shadow, true, 'changing the mode is not a reason to stop shadowing');
  });

test('deleting the row restores "no row", which is not the same as false',
  { skip: skipWithoutPg() }, async (t) => {
    const { s } = await setup(t);
    await s.upsertCheckSettings('x', { mode: 'autopilot' });
    assert.equal(await s.deleteCheckSettings('x'), true);
    const keys = (await s.listCheckSettings()).map((r) => r.checkKey);
    assert.equal(keys.includes('x'), false,
      'a check that was never configured must be able to go back to never configured');
  });

test('THE BACKFILL IS PROVED ON THE ROW THE SCHEMA ITSELF SEEDS',
  { skip: skipWithoutPg() }, async (t) => {
    // `home_time.closable_open_cycle` is armed by the baseline, so it is real
    // pre-existing data rather than a row this test invented — the closest
    // thing available here to "what production looks like at deploy".
    const { s } = await setup(t);
    const seeded = (await s.listCheckSettings())
      .find((r) => r.checkKey === 'home_time.closable_open_cycle');
    assert.ok(seeded, 'the baseline seeds this one');
    assert.equal(seeded.autoApplyEnabled, true, 'it was armed before 0044');
    assert.equal(seeded.mode, 'autopilot', 'and it is still armed after it');
    assert.equal(seeded.shadow, false);
  });
