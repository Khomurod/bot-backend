/**
 * The retention pass, against the real schema.
 *
 * WHAT PROMPTED IT. An audit found prune functions WRITTEN AND NEVER CALLED:
 * `pruneOldSafetyEvents` has a 180-day window, a test, and no caller anywhere
 * outside tests; `pruneAiCallLog`'s only caller is a test file. Several newer
 * tables had no prune at all and grow on every tick — including one
 * `operational_findings` row per load order ever seen, because resolving a
 * finding updates its status and never deletes it.
 *
 * EVERY ASSERTION THAT MATTERS IS A REFUSAL. Age is not resolution: an open
 * finding and an undelivered notice are somebody's alarm that has not gone off
 * yet, and deleting either would make a problem invisible rather than solved.
 * A pass that got this wrong would be indistinguishable from one working
 * correctly until the day somebody went looking for a finding that was quietly
 * swept away.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  // The real data-layer modules, bound to the throwaway database. The pass is
  // pure orchestration over them, so injecting the layer is the whole seam.
  const layer = h.loadDataLayer(['driverSafety', 'aiCallLog', 'pool']);
  // eslint-disable-next-line global-require
  const retention = require('../services/operations/dataRetention');
  return {
    h,
    retention,
    deps: { query: layer.pool.query, safety: layer.driverSafety, aiCallLog: layer.aiCallLog },
  };
}

const daysAgo = (n) => `NOW() - INTERVAL '${n} days'`;

test('old resolved findings go; OPEN ones of any age stay', { skip: skipWithoutPg() }, async (t) => {
  const { h, retention, deps } = await setup(t);
  await h.query(
    `INSERT INTO operational_findings (check_key, subject_type, subject_id, title, status, resolved_at, first_seen_at, last_seen_at)
     VALUES ('load.phase_unclear','load','1','old resolved','resolved',${daysAgo(200)},${daysAgo(200)},${daysAgo(200)}),
            ('load.phase_unclear','load','2','recent resolved','resolved',${daysAgo(3)},${daysAgo(3)},${daysAgo(3)}),
            ('home_time.stay','group','3','ancient OPEN','open',NULL,${daysAgo(400)},${daysAgo(400)})`
  );

  const { deleted, errors } = await retention.runDataRetentionPass({ deps });
  assert.deepEqual(errors, []);
  assert.equal(deleted.findings, 1);

  const left = await h.query('SELECT title FROM operational_findings ORDER BY id');
  assert.deepEqual(left.rows.map((r) => r.title), ['recent resolved', 'ancient OPEN'],
    'a finding nobody has dealt with in a year is a worse problem than a large '
    + 'table, and deleting it would hide it rather than solve it');
});

test('delivered notices go; a PENDING one stays however old', { skip: skipWithoutPg() }, async (t) => {
  const { h, retention, deps } = await setup(t);
  await h.query(
    `INSERT INTO operational_notifications (notice_key, category, chat_id, routed_via, body, state, created_at)
     VALUES ('a','fuel','-1','default','x','delivered',${daysAgo(200)}),
            ('b','fuel','-1','default','x','abandoned',${daysAgo(200)}),
            ('c','fuel','-1','default','x','delivered',${daysAgo(2)}),
            ('d','fuel','-1','default','x','pending',${daysAgo(500)})`
  );

  const { deleted } = await retention.runDataRetentionPass({ deps });
  assert.equal(deleted.notices, 2);

  const left = await h.query('SELECT notice_key FROM operational_notifications ORDER BY notice_key');
  assert.deepEqual(left.rows.map((r) => r.notice_key), ['c', 'd'],
    'a pending notice is an alarm that has not gone off yet');
});

test('safety events past the window go — the prune that existed and was never called',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, retention, deps } = await setup(t);
    await h.query(
      `INSERT INTO driver_safety_events (samsara_event_id, behavior, occurred_at)
       VALUES ('e1','harsh_braking',${daysAgo(400)}),
              ('e2','harsh_braking',${daysAgo(10)})`
    );
    const { deleted } = await retention.runDataRetentionPass({ deps });
    assert.equal(deleted.safetyEvents, 1);
    const left = await h.query('SELECT samsara_event_id FROM driver_safety_events');
    assert.deepEqual(left.rows.map((r) => r.samsara_event_id), ['e2']);
  });

test('service_runs idempotency keys are trimmed — group_status_ai writes one an hour',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, retention, deps } = await setup(t);
    await h.query(
      `INSERT INTO service_runs (service_name, run_key, ran_at)
       VALUES ('group_status_ai','2026-01-01:00',${daysAgo(200)}),
              ('group_status_ai','2026-09-20:00',${daysAgo(1)})`
    );
    const { deleted } = await retention.runDataRetentionPass({ deps });
    assert.equal(deleted.serviceRuns, 1);
  });

test('a table that is missing costs that one deletion, never the whole pass',
  { skip: skipWithoutPg() }, async (t) => {
    const { retention, deps } = await setup(t);
    const broken = {
      ...deps,
      safety: { async pruneOldSafetyEvents() { throw new Error('relation does not exist'); } },
    };
    const { deleted, errors } = await retention.runDataRetentionPass({ deps: broken });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^safetyEvents:/);
    assert.ok('notices' in deleted, 'and everything after it still ran');
  });

test('nothing old enough means a clean pass with zero deletions, not an error',
  { skip: skipWithoutPg() }, async (t) => {
    const { retention, deps } = await setup(t);
    const { deleted, errors } = await retention.runDataRetentionPass({ deps });
    assert.deepEqual(errors, []);
    assert.equal(Object.values(deleted).reduce((n, v) => n + v, 0), 0);
  });
