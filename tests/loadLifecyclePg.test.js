/**
 * The load-lifecycle store against a real PostgreSQL.
 *
 * The one thing that genuinely needs a database: A WITNESSED ARRIVAL IS NEVER
 * FORGOTTEN. "Delivered" is the truck having been at the receiver and then
 * left, so the arrival has to survive every later pass in which the truck is
 * nowhere near it — which is a claim about an OR-ed UPDATE, not about
 * JavaScript.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function seed(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await harness.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES (7, -1007, 'WENZE UNIT # 310 A DRIVER', 'driver', TRUE)`
  );
  return harness;
}

const load = (h) => h.loadDataLayer(['loadLifecycle']).loadLifecycle;

const SHIPPER = { lat: 41.88, lng: -87.63 };

test('a first sighting creates the row with its phase and its clock',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const db = load(harness);
    await db.recordLoadObservation('ORD-1', {
      loadIdentifier: 'L1', groupId: 7, unitNumber: '310',
      phase: 'at_pickup', confidence: 'high', atPickup: true,
      ...SHIPPER, speedMph: 0, seenAt: '2026-09-20T12:00:00Z',
      boardStatus: 'dispatched', signals: ['gps_fresh', 'at_pickup'],
    });
    const row = await db.getLoadState('ORD-1');
    assert.equal(row.phase, 'at_pickup');
    assert.equal(row.wasAtPickup, true);
    assert.ok(row.firstAtPickupAt);
    assert.deepEqual(row.signals, ['gps_fresh', 'at_pickup']);
  });

test('a WITNESSED arrival survives every later pass that cannot see it',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const db = load(harness);
    await db.recordLoadObservation('ORD-1', { phase: 'at_pickup', atPickup: true, ...SHIPPER });
    // Two hundred miles later the truck is nowhere near the shipper. Without the
    // OR, this pass would erase the only evidence that it ever loaded.
    await db.recordLoadObservation('ORD-1', {
      phase: 'in_transit', atPickup: false, lat: 40.0, lng: -85.0, speedMph: 62,
    });
    const after = await db.getLoadState('ORD-1');
    assert.equal(after.wasAtPickup, true, 'a departure is not evidence the arrival was imagined');
    assert.equal(after.phase, 'in_transit');
  });

test('the first arrival time is kept, not overwritten by a later one',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const db = load(harness);
    await db.recordLoadObservation('ORD-1', {
      phase: 'at_pickup', atPickup: true, checkedAt: '2026-09-20T08:00:00Z',
    });
    const first = await db.getLoadState('ORD-1');
    await db.recordLoadObservation('ORD-1', {
      phase: 'at_pickup', atPickup: true, checkedAt: '2026-09-20T14:00:00Z',
    });
    const second = await db.getLoadState('ORD-1');
    assert.equal(
      new Date(second.firstAtPickupAt).toISOString(),
      new Date(first.firstAtPickupAt).toISOString(),
      'how long has it been sitting at the shipper is only answerable from the FIRST'
    );
  });

test('the phase clock moves only when the phase actually changes',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const db = load(harness);
    await db.recordLoadObservation('ORD-1', {
      phase: 'at_delivery', atDelivery: true, checkedAt: '2026-09-20T08:00:00Z',
    });
    const a = await db.getLoadState('ORD-1');
    await db.recordLoadObservation('ORD-1', {
      phase: 'at_delivery', atDelivery: true, checkedAt: '2026-09-20T12:00:00Z',
    });
    const b = await db.getLoadState('ORD-1');
    assert.equal(new Date(b.phaseSince).toISOString(), new Date(a.phaseSince).toISOString(),
      '"four hours at the receiver" is the question this answers');

    await db.recordLoadObservation('ORD-1', {
      phase: 'delivered', checkedAt: '2026-09-20T13:00:00Z',
    });
    const c = await db.getLoadState('ORD-1');
    assert.notEqual(new Date(c.phaseSince).toISOString(), new Date(a.phaseSince).toISOString());
  });

test('the latest sighting overwrites the previous one — this is not a position history',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const db = load(harness);
    await db.recordLoadObservation('ORD-1', { phase: 'in_transit', ...SHIPPER, speedMph: 0 });
    await db.recordLoadObservation('ORD-1', { phase: 'in_transit', lat: 40.0, lng: -85.0, speedMph: 62 });
    const row = await db.getLoadState('ORD-1');
    assert.equal(Math.round(row.last.lat), 40);
    const count = await harness.query('SELECT COUNT(*)::int AS n FROM load_lifecycle');
    assert.equal(count.rows[0].n, 1, 'one row per load, always');
  });

test('a conflict is stored beside the phase, readable without re-fetching the board',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const db = load(harness);
    await db.recordLoadObservation('ORD-1', {
      phase: 'at_pickup', confidence: 'medium', boardStatus: 'in_transit',
      conflicts: ['board_says_loaded_but_the_truck_has_not_left_the_shipper'],
    });
    const row = await db.getLoadState('ORD-1');
    assert.equal(row.boardStatus, 'in_transit');
    assert.equal(row.conflicts.length, 1);
    const summary = await db.summariseLoadPhases();
    assert.equal(summary.conflicted, 1);
    assert.equal(summary.unclear, 1);
  });

test('an unknown phase is refused by the schema, not stored', { skip: skipWithoutPg() }, async (t) => {
  const harness = await seed(t);
  const db = load(harness);
  await assert.rejects(() => db.recordLoadObservation('ORD-1', { phase: 'somewhere' }), /phase/);
});

test('finished loads are pruned, recent ones are kept', { skip: skipWithoutPg() }, async (t) => {
  const harness = await seed(t);
  const db = load(harness);
  await db.recordLoadObservation('ORD-OLD', { phase: 'delivered' });
  await db.recordLoadObservation('ORD-NEW', { phase: 'delivered' });
  await db.recordLoadObservation('ORD-LIVE', { phase: 'in_transit' });
  await harness.query(
    `UPDATE load_lifecycle SET updated_at = NOW() - INTERVAL '10 days' WHERE order_id = 'ORD-OLD'`
  );
  const removed = await db.pruneFinishedLoads();
  assert.equal(removed, 1);
  const left = await db.listTrackedLoads();
  assert.deepEqual(left.map((r) => r.orderId).sort(), ['ORD-LIVE', 'ORD-NEW']);
});

test('the health summary counts by phase', { skip: skipWithoutPg() }, async (t) => {
  const harness = await seed(t);
  const db = load(harness);
  await db.recordLoadObservation('A', { phase: 'in_transit', confidence: 'high' });
  await db.recordLoadObservation('B', { phase: 'in_transit', confidence: 'high' });
  await db.recordLoadObservation('C', { phase: 'at_pickup', confidence: 'medium' });
  const s = await db.summariseLoadPhases();
  assert.equal(s.total, 3);
  assert.equal(s.byPhase.in_transit, 2);
  assert.equal(s.unclear, 1);
});

/**
 * THE OTHER HALF OF THE BARE-UNIT FIX, AT THE LAYER THE BUG LIVED IN.
 *
 * Every field here is `COALESCE`d, so handing null keeps what is stored — right
 * for a pass that could not read something. But a caller that has ESTABLISHED
 * there is no single holder of the unit is answering "nobody", and loads
 * stamped with the wrong human by the old bare-unit lookup would otherwise keep
 * them forever in the column every later feature joins on.
 */
test('a null person is KEPT by default and REMOVED when the caller says to',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const db = load(harness);
    const { rows } = await harness.query(
      "INSERT INTO driver_people (display_name, normalized_key) VALUES ('A Driver', 'adriver') RETURNING id"
    );
    const personId = rows[0].id;

    await db.recordLoadObservation('ORD-9', {
      groupId: 7, personId, unitNumber: '310', phase: 'at_pickup',
    });

    // A pass that could not read the holders. The driver must survive it.
    await db.recordLoadObservation('ORD-9', {
      groupId: 7, personId: null, unitNumber: '310', phase: 'in_transit',
    });
    const kept = await db.getLoadState('ORD-9');
    assert.equal(kept.personId, personId, 'silence means keep');

    // A pass that read them and found two. That is an answer.
    await db.recordLoadObservation('ORD-9', {
      groupId: 7, personId: null, clearPerson: true, unitNumber: '310', phase: 'in_transit',
    });
    const cleared = await db.getLoadState('ORD-9');
    assert.equal(cleared.personId, null, 'a wrong driver has to be removable');

    // And clearing is not a one-way door: a unit that becomes unambiguous again
    // re-attaches, with the flag still set, because the flag says "trust my
    // answer" rather than "erase".
    await db.recordLoadObservation('ORD-9', {
      groupId: 7, personId, clearPerson: true, unitNumber: '310', phase: 'in_transit',
    });
    const back = await db.getLoadState('ORD-9');
    assert.equal(back.personId, personId);
  });

// ── one read per pass, nothing read back ─────────────────────────────────────
// October 2026: a pass read `SELECT *` per load and echoed each write back
// whole — part of ~110 MB a day of database transfer.

test('getLoadStates: one read for the board, only the columns a pass uses', { skip: skipWithoutPg() }, async (t) => {
  const harness = await seed(t);
  const db = load(harness);
  await db.recordLoadObservation('ORD-1', { loadIdentifier: 'L1', groupId: 7, unitNumber: '310', phase: 'at_pickup', atPickup: true });
  await db.recordLoadObservation('ORD-2', { phase: 'in_transit' });

  const states = await db.getLoadStates(['ORD-1', 'ORD-2', 'ORD-NEVER', 'ORD-1', null]);
  assert.deepEqual([...states.keys()].sort(), ['ORD-1', 'ORD-2'], 'a load never seen is simply absent');
  assert.deepEqual(Object.keys(states.get('ORD-1')).sort(), [
    'groupId', 'loadIdentifier', 'orderId', 'personId', 'phase', 'phaseSince',
    'unitNumber', 'wasAtDelivery', 'wasAtPickup',
  ]);
  assert.equal(states.get('ORD-1').wasAtPickup, true);
  assert.equal(states.get('ORD-1').loadIdentifier, 'L1');
  assert.deepEqual(await db.getLoadStates([]), new Map(), 'no loads, no query');
});

test('WHAT THE WRITE RETURNS IS WHAT THE ROW HOLDS — worked out, never read back', { skip: skipWithoutPg() }, async (t) => {
  const harness = await seed(t);
  const db = load(harness);
  const person = (await harness.query(
    "INSERT INTO driver_people (display_name, normalized_key) VALUES ('A DRIVER', 'adriver') RETURNING id"
  )).rows[0].id;
  const identityOf = async (orderId) => {
    const r = (await harness.query(
      'SELECT order_id, load_identifier, group_id, person_id, unit_number, phase, confidence FROM load_lifecycle WHERE order_id = $1',
      [orderId]
    )).rows[0];
    return {
      orderId: r.order_id, loadIdentifier: r.load_identifier, groupId: r.group_id, personId: r.person_id,
      unitNumber: r.unit_number, phase: r.phase, confidence: r.confidence,
    };
  };
  const step = async (written) => {
    const before = (await db.getLoadStates(['ORD-1'])).get('ORD-1') || null;
    const returned = await db.recordLoadObservation('ORD-1', written, before);
    assert.deepEqual(returned, await identityOf('ORD-1'), JSON.stringify(written));
  };
  // A first sighting, with everything known.
  await step({ loadIdentifier: 'L1', groupId: 7, personId: person, unitNumber: '310', phase: 'at_pickup', confidence: 'high' });
  // A pass that could read nothing about who: every stored value is kept.
  await step({ phase: 'in_transit', confidence: 'medium' });
  // A read that SUCCEEDED and found no single holder removes the person.
  await step({ unitNumber: '310', clearPerson: true, phase: 'in_transit' });
  // And a later pass that knows them again puts them back.
  await step({ personId: person, phase: 'at_delivery', confidence: 'high' });
});
