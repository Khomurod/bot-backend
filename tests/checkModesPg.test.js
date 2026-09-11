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

test('THE DATABASE REFUSES A MODE THAT DISAGREES WITH THE BOOLEAN',
  { skip: skipWithoutPg() }, async (t) => {
    const { h } = await setup(t);
    await assert.rejects(() => h.query(
      `INSERT INTO operational_check_settings (check_key, auto_apply_enabled, mode)
       VALUES ('lying', TRUE, 'observe')`
    ), 'a check that says "watch only" and "apply automatically" at once is not a state');
    await assert.rejects(() => h.query(
      `INSERT INTO operational_check_settings (check_key, auto_apply_enabled, mode)
       VALUES ('lying2', FALSE, 'autopilot')`
    ));
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
