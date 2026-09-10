/**
 * The manager-notice outbox against a real PostgreSQL.
 *
 * The one promise worth a database to prove: THREE MANAGERS ARE TAGGED ONCE PER
 * EVENT. An in-memory guard cannot make that promise — Render restarts this
 * process several times a day, and the return-to-road watcher re-derives the
 * same arrival on every tick. So the guarantee is `event_key UNIQUE` plus an
 * `ON CONFLICT DO NOTHING` insert, and that is a claim about SQL, not about JS.
 *
 * Also covers migration 0029's second half: a completed request is 'recorded',
 * and the historical decisions the efficiency report reads are still legal.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function harnessWith(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await harness.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES (1, -1001, 'WENZE UNIT # 7 A DRIVER', 'driver', TRUE)`
  );
  return harness;
}

/** The outbox through the façade every service uses. */
function load(harness) {
  return harness.loadDataLayer(['homeTime']).homeTime;
}

const BASE = {
  eventType: 'arrived_home', chatId: '-100777', body: 'Driver Is Home — A',
  groupId: 1, evidence: { homeSince: '2026-09-18' },
};

test('the same event enqueued twice is stored once', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const ht = load(harness);

  const first = await ht.enqueueNotice({ ...BASE, eventKey: 'arrived_home:412' });
  const second = await ht.enqueueNotice({ ...BASE, eventKey: 'arrived_home:412', body: 'again' });

  assert.ok(first, 'the first call creates the notice');
  assert.equal(second, null, 'the second call creates nothing — and so sends nothing');
  const rows = await harness.query('SELECT * FROM home_time_manager_notices');
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].body, 'Driver Is Home — A', 'the first body stands');
});

test('the three event types are distinct events for the same cycle', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const ht = load(harness);
  await ht.enqueueNotice({ ...BASE, eventType: 'request', eventKey: 'request:5' });
  await ht.enqueueNotice({ ...BASE, eventType: 'arrived_home', eventKey: 'arrived_home:5' });
  await ht.enqueueNotice({ ...BASE, eventType: 'back_on_road', eventKey: 'back_on_road:5' });
  const rows = await harness.query('SELECT event_type FROM home_time_manager_notices ORDER BY event_type');
  assert.deepEqual(rows.rows.map((r) => r.event_type), ['arrived_home', 'back_on_road', 'request']);
});

test('an unknown event type is refused by the schema', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const ht = load(harness);
  await assert.rejects(
    () => ht.enqueueNotice({ ...BASE, eventType: 'approved', eventKey: 'approved:1' }),
    /event_type/
  );
});

test('a claim takes the lease and spends the attempt, so a crash loop is bounded',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const ht = load(harness);
    await ht.enqueueNotice({ ...BASE, eventKey: 'arrived_home:1' });

    const claimed = await ht.claimDueNotices({ limit: 10 });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].attempts, 1, 'counted at claim time, not on failure');

    const again = await ht.claimDueNotices({ limit: 10 });
    assert.equal(again.length, 0, 'the lease hides it from a second worker');
  });

test('a failure backs off, and the sixth gives up instead of retrying forever',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const ht = load(harness);
    const row = await ht.enqueueNotice({ ...BASE, eventKey: 'arrived_home:2' });

    let state = null;
    const MAX_ATTEMPTS = 6;
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await harness.query(
        'UPDATE home_time_manager_notices SET next_attempt_at = NOW() - INTERVAL \'1 hour\', claimed_until = NULL WHERE id = $1',
        [row.id]
      );
      // eslint-disable-next-line no-await-in-loop
      const [claimed] = await ht.claimDueNotices({ limit: 1 });
      assert.ok(claimed, `attempt ${i + 1} is claimable`);
      // eslint-disable-next-line no-await-in-loop
      state = await ht.markNoticeFailed(claimed.id, 'chat not found');
    }
    assert.equal(state.state, 'failed', 'it stops rather than tagging managers forever');
    assert.equal(state.attempts, MAX_ATTEMPTS);

    const counts = await ht.countFailedNotices();
    assert.equal(counts.count, 1, 'and it is countable on /api/health');
  });

test('delivery clears the lease and records the message id', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const ht = load(harness);
  const row = await ht.enqueueNotice({ ...BASE, eventKey: 'arrived_home:3' });
  const [claimed] = await ht.claimDueNotices({ limit: 1 });
  const done = await ht.markNoticeDelivered(claimed.id, { telegramMessageId: 909 });
  assert.equal(done.state, 'delivered');
  assert.equal(String(done.telegramMessageId), '909', 'BIGINT comes back as a string');
  assert.ok(done.deliveredAt);
  const left = await ht.claimDueNotices({ limit: 10 });
  assert.equal(left.length, 0, 'a delivered notice is never claimed again');
  assert.equal(row.state, 'pending');
});

test('a notice outlives the cycle and the chat it describes', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const ht = load(harness);
  const cycle = await harness.query(
    `INSERT INTO driver_road_history (group_id, road_started_at, home_arrived_at, days_on_road, bonus_usd)
     VALUES (1, NOW() - INTERVAL '40 days', NOW(), 40, 100) RETURNING id`
  );
  await ht.enqueueNotice({ ...BASE, eventKey: 'arrived_home:99', roadHistoryId: cycle.rows[0].id });
  await harness.query('DELETE FROM driver_road_history WHERE id = $1', [cycle.rows[0].id]);
  await harness.query('DELETE FROM groups WHERE id = 1');
  const rows = await harness.query('SELECT road_history_id, group_id FROM home_time_manager_notices');
  assert.equal(rows.rows.length, 1, 'the record of what a manager was told survives');
  assert.equal(rows.rows[0].road_history_id, null);
  assert.equal(rows.rows[0].group_id, null);
});

// ── migration 0029, second half: a request that waits for nobody ─────────────

test("'recorded' is a legal request status and the historical decisions still are",
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    for (const status of ['recorded', 'pending', 'approved', 'denied', 'expired', 'cancelled']) {
      // eslint-disable-next-line no-await-in-loop
      await harness.query(
        `INSERT INTO home_time_requests (group_id, telegram_group_id, driver_name, status)
         VALUES (1, -1001, 'A', $1)`,
        [status]
      );
    }
    const rows = await harness.query('SELECT COUNT(*)::int AS n FROM home_time_requests');
    assert.equal(rows.rows[0].n, 6);
    await assert.rejects(
      () => harness.query(
        `INSERT INTO home_time_requests (group_id, driver_name, status) VALUES (1, 'A', 'awaiting_approval')`
      ),
      /status/
    );
  });

test('completing a request records it — nothing is left waiting for a decision',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const { homeTime } = harness.loadDataLayer(['homeTime']);
    const created = await homeTime.insertHomeTimeRequest({
      groupId: 1, telegramGroupId: -1001, driverName: 'A', status: 'awaiting_return_to_road',
      homeFrom: '2026-09-18',
    });
    const done = await homeTime.fulfillAwaitingHomeTimeRequest(created.id, {
      homeFrom: '2026-09-18', homeTo: '2026-09-21', returnToRoadDate: '2026-09-22',
      daysOnRoad: 40, policyMet: true,
    });
    assert.equal(done.status, 'recorded');
    // And it is still the request a completing cycle links to.
    const near = await homeTime.findDecidedRequestNearDate(1, '2026-09-18');
    assert.equal(near.id, created.id);
  });
