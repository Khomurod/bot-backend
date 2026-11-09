'use strict';

/**
 * Migrations 0088/0098 and database/boardBitrix.js on a real PostgreSQL: the switch
 * is OFF until somebody turns it on; a pass is one transaction that opens,
 * keeps and resolves; a difference that comes back reopens its own row; only
 * one question is ever out; a redelivered reply is claimed once; "skip"
 * snoozes for a day.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const found = (key, priority = 10, extra = {}) => ({ key, kind: key.split(':')[0], priority, ...extra });

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { boardBitrix: store } = h.loadDataLayer(['boardBitrix']);
  return { h, store };
}

test('the switch is OFF after the migration and remembers who turned it on', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  const initial = await store.getSettings();
  assert.equal(initial.enabled, false);
  assert.equal(initial.syncMode, 'off');
  assert.equal(initial.maxUpdatesPerPass, 10);
  const on = await store.setEnabled(true, 'owner');
  assert.equal(on.enabled, true);
  assert.equal(on.updatedBy, 'owner');
});

test('status sync settings and the validated schema are stored, but live remains an explicit choice', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  await store.recordSchema({
    mapping: { categoryId: 9, stageByRole: { HOME: 'D9:H' } },
    fingerprint: 'schema-9', source: 'catalog_exact', confidence: 100,
  });
  let settings = await store.setSyncSettings({ syncMode: 'dry_run', maxUpdatesPerPass: 4 }, 'owner');
  assert.equal(settings.syncMode, 'dry_run');
  assert.equal(settings.maxUpdatesPerPass, 4);
  assert.equal(settings.schemaFingerprint, 'schema-9');
  assert.equal(settings.schemaSource, 'catalog_exact');
  assert.equal(settings.schemaConfidence, 100);
  settings = await store.setSyncSettings({ syncMode: 'off', maxUpdatesPerPass: 4 }, 'owner');
  assert.equal(settings.syncMode, 'off');

  await store.setEnabled(true, 'owner');
  settings = await store.setSyncSettings({ syncMode: 'live', maxUpdatesPerPass: 4 }, 'owner');
  assert.equal(settings.syncMode, 'live');
  assert.equal(await store.isLiveSyncEnabled(), true);
  settings = await store.setEnabled(false, 'owner');
  assert.equal(settings.syncMode, 'off', 'turning the check off revokes its old live permission');
  assert.equal(await store.isLiveSyncEnabled(), false);
  await assert.rejects(
    store.setSyncSettings({ syncMode: 'live', maxUpdatesPerPass: 4 }, 'owner'),
    (err) => err.code === 'BOARD_BITRIX_CHECK_OFF',
  );
});

test('stage actions are idempotent across processes, and an applied transition is never repeated', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  const action = {
    actionKey: 'stage:test:one', dealId: 321, boardStatus: 'HOME',
    beforeStageId: 'D9:W', targetStageId: 'D9:H', schemaFingerprint: 'schema-9',
  };
  assert.equal(await store.recordPlannedStageSync({ ...action, actionKey: 'stage:test:dry' }), true);
  assert.equal(await store.recordPlannedStageSync({ ...action, actionKey: 'stage:test:dry' }), false);

  const claim = await store.claimStageSync(action);
  assert.ok(claim);
  assert.equal(await store.claimStageSync(action), null, 'an active lease cannot be double-claimed');
  await store.finishStageSync(claim, 'applied');
  assert.equal(await store.claimStageSync(action), null, 'an applied action is terminal');
});

test('the pre-write Board check accepts only the same still-present status event', { skip: skipWithoutPg() }, async (t) => {
  const { h, store } = await setup(t);
  await h.query(
    `INSERT INTO dispatch_board_rows
       (row_key, driver_name_raw, driver_name_clean, fleet_type, truck_raw,
        truck_norm, status, status_changed_at, present)
     VALUES ('board:321', 'ALAN BROWN', 'ALAN BROWN', 'owner_operator',
             '001', '001', 'HOME', '2026-11-09T18:00:00.123456Z', TRUE)`
  );
  const event = {
    rowKey: 'board:321', boardStatus: 'HOME',
    statusChangedAt: '2026-11-09T18:00:00.123Z',
  };
  assert.equal(await store.confirmBoardStatus(event), true, 'sub-millisecond database precision is harmless');
  await h.query(`UPDATE dispatch_board_rows SET status = 'READY', status_changed_at = NOW() WHERE row_key = 'board:321'`);
  assert.equal(await store.confirmBoardStatus(event), false);
});

test('a pass opens what is new, keeps what is still there, resolves what is gone — and a comeback reopens the same row', { skip: skipWithoutPg() }, async (t) => {
  const { h, store } = await setup(t);
  let out = await store.applyPass([found('not_on_board:deal:1'), found('fleet_missing:deal:2', 60)]);
  assert.equal(out.opened.length, 2);
  assert.equal(out.resolved.length, 0);

  // The same differences again: nothing is rewritten (the row version stays).
  const version = async () => (await h.query(`SELECT xmin::text AS x FROM board_bitrix_discrepancies ORDER BY id`)).rows.map((r) => r.x);
  const versionBefore = await version();
  await store.applyPass([found('not_on_board:deal:1'), found('fleet_missing:deal:2', 60)]);
  assert.deepEqual(await version(), versionBefore, 'an unchanged difference is not rewritten');

  out = await store.applyPass([found('fleet_missing:deal:2', 60, { note: 'new details' })]);
  assert.equal(out.opened.length, 0);
  assert.deepEqual(out.resolved.map((r) => r.key), ['not_on_board:deal:1']);
  assert.equal(out.resolved[0].resolvedHow, 'seen_fixed');
  const kept = (await h.query(`SELECT details FROM board_bitrix_discrepancies WHERE discrepancy_key = 'fleet_missing:deal:2'`)).rows[0];
  assert.equal(kept.details.note, 'new details', 'the details follow the latest pass');

  out = await store.applyPass([found('not_on_board:deal:1'), found('fleet_missing:deal:2', 60)]);
  assert.deepEqual(out.reopened, ['not_on_board:deal:1']);
  const rows = (await h.query('SELECT discrepancy_key, state, times_reopened FROM board_bitrix_discrepancies ORDER BY id')).rows;
  assert.equal(rows.length, 2, 'never a second row for the same subject');
  assert.deepEqual(rows[0], { discrepancy_key: 'not_on_board:deal:1', state: 'open', times_reopened: 1 });
});

test('one question out at a time: most important first, a second ask is refused by the database', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  await store.applyPass([found('fleet_missing:deal:2', 60), found('missing_in_bitrix:person:A B', 10), found('truck_differs:deal:3', 30)]);
  const next = await store.nextToAsk();
  assert.equal(next.key, 'missing_in_bitrix:person:A B');
  assert.ok(await store.markAsked(next.id));
  assert.equal((await store.currentQuestion()).id, next.id);
  assert.equal(await store.countWaiting(), 2);
  const other = await store.nextToAsk();
  await assert.rejects(store.markAsked(other.id), (err) => err.code === '23505');
  assert.equal(await store.markAsked(next.id), null, 'an asked row does not move again');
});

test('a reply is claimed once per Telegram message; a redelivery gets nothing', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  await store.applyPass([found('truck_differs:deal:3', 30)]);
  const q = await store.markAsked((await store.nextToAsk()).id);
  assert.ok(await store.claimReply(q.id, 501, 2117922421));
  assert.equal(await store.claimReply(q.id, 501, 2117922421), null, 'the same message again');
  assert.ok(await store.claimReply(q.id, 502, 2117922421), 'a new reply is a new claim');
});

test('the owner\'s "done" resolves as confirmed; the asked row is reported as such', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  await store.applyPass([found('truck_differs:deal:3', 30), found('fleet_missing:deal:4', 60)]);
  const q = await store.markAsked((await store.nextToAsk()).id);
  const out = await store.applyPass([found('fleet_missing:deal:4', 60)], { confirmId: q.id });
  assert.equal(out.resolved.length, 1);
  assert.equal(out.resolved[0].resolvedHow, 'confirmed');
  assert.equal(out.resolved[0].wasAsked, true);
  assert.equal(await store.currentQuestion(), null);
});

test('"skip" puts it back for a day; it is not asked again before then, others are', { skip: skipWithoutPg() }, async (t) => {
  const { h, store } = await setup(t);
  await store.applyPass([found('missing_in_bitrix:person:A B', 10), found('fleet_missing:deal:4', 60)]);
  const q = await store.markAsked((await store.nextToAsk()).id);
  const snoozed = await store.snooze(q.id, 24);
  assert.equal(snoozed.state, 'open');
  assert.equal((await store.nextToAsk()).key, 'fleet_missing:deal:4');
  await h.query(`UPDATE board_bitrix_discrepancies SET snoozed_until = NOW() - INTERVAL '1 minute' WHERE id = $1`, [q.id]);
  assert.equal((await store.nextToAsk()).id, q.id, 'back first once the day is over');
  const summary = await store.summarise();
  assert.equal(summary.open, 2);
  assert.equal(summary.asked, 0);
});

test('a question that reached nobody goes back in line', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  await store.applyPass([found('truck_differs:deal:3', 30)]);
  const q = await store.markAsked((await store.nextToAsk()).id);
  await store.unmarkAsked(q.id);
  const back = await store.nextToAsk();
  assert.equal(back.id, q.id);
  assert.equal(back.askCount, 0);
});
