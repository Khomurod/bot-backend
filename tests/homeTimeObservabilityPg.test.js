/**
 * The health block's four queries, against the real schema.
 *
 * The unit tests above prove the SHAPE is safe; these prove the SQL is valid
 * and counts what it claims. A query that does not compile would otherwise show
 * up only as `available: false` on a live /api/health — a silent loss of the
 * one production check this work depends on.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function seed(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await harness.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES (1, -1001, 'WENZE UNIT # 7 A DRIVER', 'driver', TRUE),
            (2, -1002, 'WENZE UNIT # 8 B DRIVER', 'driver', TRUE)`
  );
  return harness;
}

function load(harness) {
  return harness.loadDataLayer(['homeTime/observability'])['homeTime/observability'];
}

test('an empty fleet reports zeros rather than failing', { skip: skipWithoutPg() }, async (t) => {
  const harness = await seed(t);
  const obs = load(harness);
  const watch = await obs.summariseReturnWatch();
  assert.equal(watch.watching, 0);
  assert.equal(watch.lastCheckedAt, null);
  assert.deepEqual(await obs.summariseManagerNotices(), {});
  assert.deepEqual(await obs.summariseRequestStatuses(), {});
  assert.equal((await obs.summariseReturnCorrections()).applied, 0);
});

test('the watch summary separates a running worker from an empty one',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    await harness.query(
      `INSERT INTO home_time_return_watch
         (group_id, home_since, anchor_lat, anchor_lng, last_checked_at, last_confidence)
       VALUES (1, NOW() - INTERVAL '3 days', 41.88, -87.63, NOW() - INTERVAL '2 minutes', 'medium'),
              (2, NOW() - INTERVAL '1 day', NULL, NULL, NOW() - INTERVAL '11 minutes', 'low')`
    );
    const watch = await load(harness).summariseReturnWatch();
    assert.equal(watch.watching, 2);
    assert.equal(watch.anchored, 1, 'only the truck seen parked has an anchor');
    assert.equal(watch.medium, 1);
    assert.equal(watch.low, 1);
    assert.equal(watch.high, 0);
    assert.ok(watch.lastCheckedAt && watch.oldestCheckedAt,
      'both ends are reported, so a worker that stopped reads as a stale oldest');
  });

test('rows and distinct events agree, because event_key is UNIQUE',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const ht = harness.loadDataLayer(['homeTime']).homeTime;
    for (const [type, key] of [['request', 'request:1'], ['arrived_home', 'arrived_home:1'],
      ['back_on_road', 'back_on_road:1'], ['arrived_home', 'arrived_home:2']]) {
      // eslint-disable-next-line no-await-in-loop
      await ht.enqueueNotice({
        eventType: type, eventKey: key, chatId: '-100777', body: 'x', groupId: 1, evidence: {},
      });
    }
    // The same event again, which the constraint must swallow.
    await ht.enqueueNotice({
      eventType: 'arrived_home', eventKey: 'arrived_home:1', chatId: '-100777', body: 'again',
      groupId: 1, evidence: {},
    });

    const notices = await load(harness).summariseManagerNotices();
    assert.equal(notices.arrived_home.rows, 2);
    assert.equal(notices.arrived_home.events, 2, 'the repeat added nothing');
    assert.equal(notices.request.rows, 1);
    assert.equal(notices.back_on_road.rows, 1);
    assert.equal(notices.arrived_home.pending, 2, 'enqueued, not yet sent');
  });

test('requests report `recorded` beside the preserved historical statuses',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    for (const status of ['recorded', 'recorded', 'pending', 'approved', 'denied', 'expired']) {
      // eslint-disable-next-line no-await-in-loop
      await harness.query(
        `INSERT INTO home_time_requests (group_id, telegram_group_id, driver_name, status)
         VALUES (1, -1001, 'A', $1)`,
        [status]
      );
    }
    const byStatus = await load(harness).summariseRequestStatuses();
    assert.equal(byStatus.recorded, 2);
    assert.equal(byStatus.pending, 1);
    assert.equal(byStatus.approved, 1);
    assert.equal(byStatus.denied, 1);
  });

test('an automatic return, and its reversal, are both counted',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    await harness.query(
      // `reverted_by` is not optional: the schema refuses an unattributed
      // reversal, which is why the fixture names one.
      `INSERT INTO operational_corrections
         (action_key, tier, subject_type, subject_id, old_values, new_values, initiator,
          applied_at, reverted_at, reverted_by)
       VALUES ('home_time.mark_returned_to_road', 'auto', 'road_history', '1', '{}', '{}', 'system', NOW(), NULL, NULL),
              ('home_time.mark_returned_to_road', 'auto', 'road_history', '2', '{}', '{}', 'system', NOW(), NOW(), 'admin:3'),
              ('home_time.close_open_cycle', 'auto', 'road_history', '3', '{}', '{}', 'system', NOW(), NULL, NULL)`
    );
    const out = await load(harness).summariseReturnCorrections();
    assert.equal(out.applied, 2, 'only this action, not every home-time correction');
    assert.equal(out.reverted, 1);
    assert.ok(out.lastAppliedAt);
  });
