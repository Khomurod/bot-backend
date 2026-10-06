'use strict';

/**
 * The road-bonus decision against a real PostgreSQL: the CHECK, the guarded
 * decision write, the post queue that only sees decided legs, and a person
 * releasing a held bonus through the audited correction registry.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { POOL_PATH, purgeDataLayer } = require('./helpers/purgeDataLayer');

const ALL_MIGRATIONS = allMigrationsSql();
const SERVICE_PATHS = [
  '../services/operations/corrections/actions', '../services/operations/corrections/roadBonusActions',
  '../services/operations/corrections/apply',
].map((p) => path.resolve(__dirname, `${p}.js`));

function bindApply(harness) {
  purgeDataLayer(SERVICE_PATHS);
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true,
    exports: { pool: harness.pool, query: harness.query, ping: async () => true },
  };
  try {
    const db = { pool: harness.pool, query: harness.query };
    const apply = require('../services/operations/corrections/apply');
    return {
      applyCorrection: (a) => apply.applyCorrection({ ...a, db }),
      revertCorrection: (a) => apply.revertCorrection({ ...a, db }),
    };
  } finally {
    delete require.cache[POOL_PATH];
    purgeDataLayer(SERVICE_PATHS);
  }
}

const ADMIN = { id: 1, username: 'admin', roleKeys: ['super_admin'], ip: null };

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await h.query("INSERT INTO admins (id, username, password_hash) VALUES (1,'admin','x') ON CONFLICT DO NOTHING");
  await h.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES (7, -9007, 'WENZE UNIT # 310 TEST DRIVER (COMPANY DRIVER)', 'driver', TRUE)`
  );
  const layer = h.loadDataLayer(['homeTime']);
  return { h, ht: layer.homeTime };
}

async function insertLeg(ht, over = {}) {
  return ht.insertRoadHistory({
    groupId: 7, driverName: 'TEST DRIVER', unitNumber: '310',
    roadStartedAt: '2026-08-01T00:00:00Z', homeArrivedAt: '2026-09-12T00:00:00Z',
    daysOnRoad: 42, exceededWeeks: 2, bonusUsd: 200, bonusDecision: 'waiting_home_stay', ...over,
  });
}

test('the CHECK refuses a decision nobody defined', { skip: skipWithoutPg() }, async (t) => {
  const { h, ht } = await setup(t);
  const leg = await insertLeg(ht);
  await assert.rejects(
    () => h.query("UPDATE driver_road_history SET bonus_decision = 'paid' WHERE id = $1", [leg.id]),
    /violates check constraint/
  );
});

test('a waiting leg is not decidable until the driver is back on the road', { skip: skipWithoutPg() }, async (t) => {
  const { ht } = await setup(t);
  const leg = await insertLeg(ht);
  assert.equal((await ht.listRoadBonusesAwaitingDecision()).length, 0, 'still at home');
  assert.equal((await ht.listUnpostedRoadBonuses()).length, 0, 'and never posted while waiting');

  await ht.closeHomeStay(leg.id, { returnToRoadAt: '2026-09-15T00:00:00Z', homeDays: 3 });
  const ready = await ht.listRoadBonusesAwaitingDecision();
  assert.deepEqual(ready.map((r) => r.id), [leg.id]);
});

test('the decision is guarded on the state that was read', { skip: skipWithoutPg() }, async (t) => {
  const { ht } = await setup(t);
  const leg = await insertLeg(ht);
  const first = await ht.setRoadBonusDecision(leg.id, { from: 'waiting_home_stay', to: 'released' });
  assert.equal(first.bonus_decision, 'released');
  const second = await ht.setRoadBonusDecision(leg.id, {
    from: 'waiting_home_stay', to: 'forfeited', reason: 'late',
  });
  assert.equal(second, null, 'a second pass that read the old state loses');
});

test('only released and forfeited legs are posted; held ones never are', { skip: skipWithoutPg() }, async (t) => {
  const { ht } = await setup(t);
  const a = await insertLeg(ht, { bonusDecision: 'released' });
  const b = await insertLeg(ht, { bonusDecision: 'forfeited' });
  const c = await insertLeg(ht, { bonusDecision: 'needs_review' });
  const legacy = await insertLeg(ht, { bonusDecision: null });
  const ids = (await ht.listUnpostedRoadBonuses()).map((r) => r.id).sort();
  assert.deepEqual(ids, [a.id, b.id].sort());
  assert.equal(await ht.claimRoadBonusPost(c.id), null, 'a held leg cannot be claimed');
  assert.equal(await ht.claimRoadBonusPost(legacy.id), null, 'nor can an undecided one');
  assert.ok(await ht.claimRoadBonusPost(a.id));
});

test('a person releases a held bonus, audited, and can undo it before it posts', { skip: skipWithoutPg() }, async (t) => {
  const { h, ht } = await setup(t);
  const { applyCorrection, revertCorrection } = bindApply(h);
  const leg = await insertLeg(ht, { bonusDecision: 'needs_review', daysOnRoad: 117, bonusUsd: 1200 });

  const correction = await applyCorrection({
    actionKey: 'home_time.release_road_bonus',
    payload: { roadHistoryId: leg.id }, admin: ADMIN, reason: 'trip checked',
  });
  let row = await h.query('SELECT bonus_decision FROM driver_road_history WHERE id = $1', [leg.id]);
  assert.equal(row.rows[0].bonus_decision, 'released');
  assert.deepEqual((await ht.listUnpostedRoadBonuses()).map((r) => r.id), [leg.id]);

  await revertCorrection({ correctionId: correction.id, admin: ADMIN, reason: 'undo' });
  row = await h.query('SELECT bonus_decision FROM driver_road_history WHERE id = $1', [leg.id]);
  assert.equal(row.rows[0].bonus_decision, 'needs_review');
});

test('a bonus that is not held cannot be "released"', { skip: skipWithoutPg() }, async (t) => {
  const { h, ht } = await setup(t);
  const { applyCorrection } = bindApply(h);
  const leg = await insertLeg(ht, { bonusDecision: 'forfeited' });
  await assert.rejects(
    () => applyCorrection({
      actionKey: 'home_time.release_road_bonus',
      payload: { roadHistoryId: leg.id }, admin: ADMIN, reason: 'x',
    }),
    /no longer held/
  );
});

test('a restart no longer marks waiting bonuses as posted', { skip: skipWithoutPg() }, async (t) => {
  // The baseline ran a "one-time" UPDATE on every boot that stamped every
  // unposted leg as posted. Re-applying the whole baseline is what a boot does.
  const { h, ht } = await setup(t);
  const leg = await insertLeg(ht);
  // eslint-disable-next-line global-require
  const fs = require('node:fs');
  await h.query(fs.readFileSync(path.resolve(__dirname, '../database/schema.sql'), 'utf8'));
  const row = await h.query('SELECT bonus_posted_at FROM driver_road_history WHERE id = $1', [leg.id]);
  assert.equal(row.rows[0].bonus_posted_at, null);
});
