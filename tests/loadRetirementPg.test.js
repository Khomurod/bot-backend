'use strict';

/**
 * Retiring the loads the board stopped returning, against a real PostgreSQL —
 * and every reader that means "now" leaving them out.
 *
 * The production reading this answers: 713 loads tracked for about a hundred
 * trucks, 289 of them in `assigned`, because nothing ever marked a load that
 * left Datatruck's window as finished.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { findContradictions } = require('../lib/drivers/context');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = h.loadDataLayer(['loadLifecycle', 'driverContext', 'driverPeople']);
  return { h, ...layer };
}

async function load(h, orderId, { phase = 'assigned', checkedMinutesAgo = 0, groupId = null } = {}) {
  await h.query(
    `INSERT INTO load_lifecycle (order_id, group_id, phase, confidence, last_checked_at, updated_at)
     VALUES ($1, $2, $3, 'high', NOW() - ($4 || ' minutes')::interval,
             NOW() - ($4 || ' minutes')::interval)`,
    [orderId, groupId, phase, String(checkedMinutesAgo)]
  );
}

async function row(h, orderId) {
  return (await h.query('SELECT * FROM load_lifecycle WHERE order_id = $1', [orderId])).rows[0];
}

test('a load missing from a good read past the grace is retired — delivered or not',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, loadLifecycle } = await setup(t);
    await load(h, 'SEEN', { phase: 'in_transit', checkedMinutesAgo: 120 });
    await load(h, 'GONE', { phase: 'assigned', checkedMinutesAgo: 120 });
    await load(h, 'DONE', { phase: 'delivered', checkedMinutesAgo: 120 });
    await load(h, 'JUST', { phase: 'in_transit', checkedMinutesAgo: 10 });

    const out = await loadLifecycle.retireMissingLoads(['SEEN']);
    assert.deepEqual(out, { retired: 2, delivered: 1 });

    assert.equal((await row(h, 'SEEN')).retired_at, null, 'still on the board');
    assert.equal((await row(h, 'GONE')).retired_reason, 'left_the_board');
    assert.equal((await row(h, 'DONE')).retired_reason, 'delivered');
    assert.equal((await row(h, 'JUST')).retired_at, null,
      'one read that misses an order checked ten minutes ago does not flip it');

    const again = await loadLifecycle.retireMissingLoads(['SEEN']);
    assert.equal(again.retired, 0, 'a retired load is not retired twice');
  });

test('an order that comes back is current again', { skip: skipWithoutPg() }, async (t) => {
  const { h, loadLifecycle } = await setup(t);
  await load(h, 'BACK', { phase: 'assigned', checkedMinutesAgo: 120 });
  await loadLifecycle.retireMissingLoads([]);
  assert.ok((await row(h, 'BACK')).retired_at);

  await loadLifecycle.recordLoadObservation('BACK', { phase: 'heading_to_pickup', confidence: 'high' });
  const back = await row(h, 'BACK');
  assert.equal(back.retired_at, null);
  assert.equal(back.retired_reason, null);
});

test('the schema refuses a retirement without a reason, and a reason without a retirement',
  { skip: skipWithoutPg() }, async (t) => {
    const { h } = await setup(t);
    await load(h, 'X');
    await assert.rejects(() => h.query(
      "UPDATE load_lifecycle SET retired_at = NOW() WHERE order_id = 'X'"
    ));
    await assert.rejects(() => h.query(
      "UPDATE load_lifecycle SET retired_reason = 'delivered' WHERE order_id = 'X'"
    ));
  });

test('the health summary counts CURRENT loads, and the retired separately',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, loadLifecycle } = await setup(t);
    await load(h, 'A', { phase: 'in_transit' });
    await load(h, 'B', { phase: 'assigned', checkedMinutesAgo: 120 });
    await load(h, 'C', { phase: 'assigned', checkedMinutesAgo: 120 });
    await loadLifecycle.retireMissingLoads(['A']);

    const s = await loadLifecycle.summariseLoadPhases();
    assert.equal(s.total, 1);
    assert.deepEqual(s.byPhase, { in_transit: 1 });
    assert.equal(s.retired, 2);
  });

test('A RETIRED LOAD IS NOT EVIDENCE — home is not contradicted by a load frozen in transit',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, loadLifecycle, driverContext, driverPeople } = await setup(t);
    const person = await driverPeople.createPerson({ displayName: 'JOHN DOE', normalizedKey: 'john doe' });
    await h.query(
      `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
       VALUES (7001, -107001, 'WENZE UNIT # 123 JOHN DOE', 'driver', TRUE)`
    );
    await h.query(
      `INSERT INTO driver_person_groups (person_id, group_id, started_at, association_source)
       VALUES ($1, 7001, NOW(), 'manual')`, [person.id]
    );
    await h.query(
      `INSERT INTO driver_home_status (group_id, state, state_since, last_status_at)
       VALUES (7001, 'home', NOW() - INTERVAL '3 days', NOW())`
    );
    await load(h, 'FROZEN', { phase: 'in_transit', checkedMinutesAgo: 4 * 24 * 60, groupId: 7001 });

    // Before retirement it reads as working — the false contradiction.
    let ctx = await driverContext.getDriverContext(person.id);
    assert.equal(ctx.loads.movingPhase, 'in_transit');
    assert.ok(findContradictions(ctx).some((c) => c.kind === 'home_while_working'));
    assert.ok((await driverContext.listContradictionCandidates()).includes(person.id));

    await loadLifecycle.retireMissingLoads([]);

    ctx = await driverContext.getDriverContext(person.id);
    assert.equal(ctx.loads.movingPhase, null);
    assert.deepEqual(findContradictions(ctx).filter((c) => c.kind === 'home_while_working'), []);
    assert.ok(!(await driverContext.listContradictionCandidates()).includes(person.id));
  });
