/**
 * A correction is only as good as the evidence it is still standing on.
 *
 * A finding is a photograph. By the time the batch acts on it, a person may have
 * edited the rows it was built from — and the dangerous version of that is not
 * "someone closed the cycle first" (easy to spot, already covered) but "someone
 * moved the arrival time" or "someone corrected the observed transition". The
 * proposal then still looks applicable while the number it carries has quietly
 * become wrong.
 *
 * These tests are the ones that say the system must NOT write in those cases,
 * plus the mirror-image rule for reverts: restoring a before-image over somebody
 * else's later edit is not an undo, it is data loss.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

const HOME_ARRIVED_AT = '2026-08-25T00:00:00Z';
const RETURNED_AT = '2026-08-31T00:00:00Z';

function loadModules(harness) {
  const db = { pool: harness.pool, query: harness.query };
  const store = harness.loadDataLayer(['operationalFindings']).operationalFindings;
  for (const p of [
    '../services/operations/corrections/actions',
    '../services/operations/corrections/apply',
  ]) delete require.cache[require.resolve(p)];
  const apply = require('../services/operations/corrections/apply');
  return {
    db,
    store,
    applyCorrection: (a) => apply.applyCorrection({ ...a, db }),
    revertCorrection: (a) => apply.revertCorrection({ ...a, db }),
  };
}

async function harnessWith(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await harness.query(
    "INSERT INTO admins (id, username, password_hash) VALUES (1,'admin','x') ON CONFLICT DO NOTHING"
  );
  return harness;
}

async function seedClosableCycle(harness, { stateSince = RETURNED_AT, driverType = 'company_driver' } = {}) {
  const g = await harness.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type, active, status_source)
     VALUES (-9101,'WENZE UNIT # 27 A','driver',TRUE,'bot') RETURNING id`
  );
  const groupId = g.rows[0].id;
  await harness.query(
    `INSERT INTO driver_profiles (group_id, first_name, last_name, status, driver_type)
     VALUES ($1,'A','ONE','active',$2)`,
    [groupId, driverType]
  );
  const r = await harness.query(
    `INSERT INTO driver_road_history
       (group_id, road_started_at, home_arrived_at, days_on_road, bonus_usd)
     VALUES ($1,'2026-07-08T00:00:00Z',$2,48,100) RETURNING id`,
    [groupId, HOME_ARRIVED_AT]
  );
  await harness.query(
    `INSERT INTO driver_home_status (group_id, state, state_since, last_status_at)
     VALUES ($1,'road',$2,$2)`,
    [groupId, stateSince]
  );
  return { groupId, cycleId: r.rows[0].id };
}

/** A decided request that authorized the stay, `offsetDays` from the arrival. */
async function seedDecidedRequest(harness, groupId, { offsetDays = 0, status = 'approved' } = {}) {
  const r = await harness.query(
    `INSERT INTO home_time_requests (group_id, status, home_from, decided_at)
     VALUES ($1, $2, DATE '2026-08-25' + $3::int, NOW()) RETURNING id`,
    [groupId, status, offsetDays]
  );
  return r.rows[0].id;
}

const closePayload = (cycleId) => ({
  actionKey: 'home_time.close_cycle',
  payload: { cycleId, returnToRoadAt: RETURNED_AT, homeDays: 6 },
});

// ─── the evidence must still hold at apply time ──────────────────────────────

test('an edited home arrival stops the correction rather than writing a stale duration',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const { applyCorrection } = loadModules(harness);
    const { cycleId } = await seedClosableCycle(harness);

    // An admin corrects the arrival date after the sweep. The stay is now 2 days,
    // not 6 — but the finding still says 6.
    await harness.query(
      "UPDATE driver_road_history SET home_arrived_at = '2026-08-29T00:00:00Z' WHERE id = $1",
      [cycleId]
    );

    await assert.rejects(
      () => applyCorrection(closePayload(cycleId)),
      (err) => err.stale === true && /2 days, not 6/.test(err.message)
    );

    const cycle = (await harness.query(
      'SELECT return_to_road_at, home_days FROM driver_road_history WHERE id = $1', [cycleId]
    )).rows[0];
    assert.equal(cycle.return_to_road_at, null, 'nothing is written on stale evidence');
    assert.equal(cycle.home_days, null);
  });

test('a moved road transition stops the correction rather than writing the old timestamp',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const { applyCorrection } = loadModules(harness);
    const { groupId, cycleId } = await seedClosableCycle(harness);

    // The observed return is corrected to a different day after the sweep.
    await harness.query(
      "UPDATE driver_home_status SET state_since = '2026-09-02T00:00:00Z' WHERE group_id = $1",
      [groupId]
    );

    await assert.rejects(
      () => applyCorrection(closePayload(cycleId)),
      (err) => err.stale === true && /return moment has moved/.test(err.message)
    );
    const cycle = (await harness.query(
      'SELECT return_to_road_at FROM driver_road_history WHERE id = $1', [cycleId]
    )).rows[0];
    assert.equal(cycle.return_to_road_at, null);
  });

test('refuses a cycle whose evidence has gone', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { applyCorrection } = loadModules(harness);
  const { groupId, cycleId } = await seedClosableCycle(harness);

  // The driver is home again: there is no longer an observed return at all.
  await harness.query(
    "UPDATE driver_home_status SET state = 'home' WHERE group_id = $1", [groupId]
  );

  await assert.rejects(
    () => applyCorrection(closePayload(cycleId)),
    (err) => err.stale === true && /no longer has closable evidence/.test(err.message)
  );
});

// ─── the authorization link ──────────────────────────────────────────────────

test('closing a cycle links the request that authorized it', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { applyCorrection } = loadModules(harness);
  const { groupId, cycleId } = await seedClosableCycle(harness);
  const requestId = await seedDecidedRequest(harness, groupId, { offsetDays: 1 });

  const correction = await applyCorrection(closePayload(cycleId));

  const cycle = (await harness.query(
    'SELECT linked_request_id FROM driver_road_history WHERE id = $1', [cycleId]
  )).rows[0];
  assert.equal(cycle.linked_request_id, requestId,
    'without this an approved over-policy stay reads as non_compliant');
  assert.equal(correction.new_values.linked_request_id, requestId,
    'the link is part of the recorded after-image, so revert can undo it');
});

test('an ambiguous authorization link is a judgement call, so nothing is closed',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const { applyCorrection } = loadModules(harness);
    const { groupId, cycleId } = await seedClosableCycle(harness);
    await seedDecidedRequest(harness, groupId, { offsetDays: -2 });
    await seedDecidedRequest(harness, groupId, { offsetDays: 2, status: 'denied' });

    await assert.rejects(
      () => applyCorrection(closePayload(cycleId)),
      (err) => err.stale === true && /judgement call/.test(err.message)
    );

    const cycle = (await harness.query(
      'SELECT return_to_road_at FROM driver_road_history WHERE id = $1', [cycleId]
    )).rows[0];
    assert.equal(cycle.return_to_road_at, null, 'left open for a person');
  });

test('a request outside the window is not linked, and the cycle still closes',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const { applyCorrection } = loadModules(harness);
    const { groupId, cycleId } = await seedClosableCycle(harness);
    await seedDecidedRequest(harness, groupId, { offsetDays: 30 });

    await applyCorrection(closePayload(cycleId));

    const cycle = (await harness.query(
      'SELECT return_to_road_at, linked_request_id FROM driver_road_history WHERE id = $1', [cycleId]
    )).rows[0];
    assert.ok(cycle.return_to_road_at);
    assert.equal(cycle.linked_request_id, null, 'a guessed link is a fabricated fact');
  });

// ─── revert is an undo, not an overwrite ─────────────────────────────────────

test('revert refuses when someone has edited the row since', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { applyCorrection, revertCorrection } = loadModules(harness);
  const { cycleId } = await seedClosableCycle(harness);

  const correction = await applyCorrection(closePayload(cycleId));

  // An admin refines the return time after the correction landed.
  await harness.query(
    "UPDATE driver_road_history SET return_to_road_at = '2026-09-01T12:00:00Z' WHERE id = $1",
    [cycleId]
  );

  await assert.rejects(
    () => revertCorrection({ correctionId: correction.id, admin: { id: 1, username: 'admin' } }),
    (err) => err.stale === true && /refusing to overwrite the newer edit/.test(err.message)
  );

  const cycle = (await harness.query(
    'SELECT return_to_road_at FROM driver_road_history WHERE id = $1', [cycleId]
  )).rows[0];
  assert.equal(new Date(cycle.return_to_road_at).toISOString(), '2026-09-01T12:00:00.000Z',
    "the admin's edit survives");
  const row = (await harness.query(
    'SELECT reverted_at FROM operational_corrections WHERE id = $1', [correction.id]
  )).rows[0];
  assert.equal(row.reverted_at, null, 'a refused revert leaves no half-done record');
});

test('reverting a status sync refuses when the profile has moved on', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { applyCorrection, revertCorrection } = loadModules(harness);
  const { groupId } = await seedClosableCycle(harness);
  await harness.query("UPDATE driver_profiles SET status = 'inactive' WHERE group_id = $1", [groupId]);

  const correction = await applyCorrection({
    actionKey: 'identity.sync_profile_status', payload: { groupId, toStatus: 'active' },
  });

  await harness.query("UPDATE driver_profiles SET status = 'inactive' WHERE group_id = $1", [groupId]);

  await assert.rejects(
    () => revertCorrection({ correctionId: correction.id, admin: { id: 1, username: 'admin' } }),
    (err) => err.stale === true
  );
});

test('a revert restores only the columns its correction actually recorded',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const { revertCorrection } = loadModules(harness);
    const { groupId, cycleId } = await seedClosableCycle(harness);
    const requestId = await seedDecidedRequest(harness, groupId);

    // A correction in the shape an earlier version of this registry wrote: it
    // closed the cycle and never touched the link, so its before-image says
    // nothing about one. The link arrived separately.
    await harness.query(
      `UPDATE driver_road_history
          SET return_to_road_at = $2, home_days = 6, linked_request_id = $3
        WHERE id = $1`,
      [cycleId, RETURNED_AT, requestId]
    );
    const c = await harness.query(
      `INSERT INTO operational_corrections
         (action_key, tier, subject_type, subject_id, old_values, new_values, initiator)
       VALUES ('home_time.close_cycle','auto','road_history',$1,
               '{"return_to_road_at": null, "home_days": null}'::jsonb,
               $2::jsonb, 'system') RETURNING id`,
      [String(cycleId), JSON.stringify({ return_to_road_at: RETURNED_AT, home_days: 6 })]
    );

    await revertCorrection({ correctionId: c.rows[0].id, admin: { id: 1, username: 'admin' } });

    const cycle = (await harness.query(
      'SELECT return_to_road_at, linked_request_id FROM driver_road_history WHERE id = $1', [cycleId]
    )).rows[0];
    assert.equal(cycle.return_to_road_at, null, 'what it recorded is undone');
    assert.equal(cycle.linked_request_id, requestId,
      'what it never recorded is left alone — silence is not permission to delete');
  });

// ─── the evidence row itself is locked, not merely read ──────────────────────

test('a status sync holds the group row it is treating as proof', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { groupId } = await seedClosableCycle(harness);
  await harness.query("UPDATE driver_profiles SET status = 'inactive' WHERE group_id = $1", [groupId]);

  // A short lock_timeout turns "waits for the lock" into an observable outcome.
  const impatient = {
    query: harness.query,
    pool: {
      connect: async () => {
        const client = await harness.pool.connect();
        await client.query("SET lock_timeout = '400ms'");
        return client;
      },
    },
  };
  const { applyCorrection } = require('../services/operations/corrections/apply');

  const blocker = await harness.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM groups WHERE id = $1 FOR UPDATE', [groupId]);

    await assert.rejects(
      () => applyCorrection({
        actionKey: 'identity.sync_profile_status',
        payload: { groupId, toStatus: 'active' },
        db: impatient,
      }),
      /lock timeout/i,
      'the group row is evidence; reading it unlocked lets a person be overruled mid-transaction'
    );
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
  }

  const profile = (await harness.query(
    'SELECT status FROM driver_profiles WHERE group_id = $1', [groupId]
  )).rows[0];
  assert.equal(profile.status, 'inactive');
});
