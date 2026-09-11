/**
 * The retention tables against a real PostgreSQL.
 *
 * Three claims that are about SQL and cannot be proved with a fake:
 *
 *   ONE OPEN ASSESSMENT PER DRIVER, where "a driver" is a person when one is
 *   known and a chat otherwise. Two partial unique indexes rather than one
 *   composite, because those are ALTERNATIVE identities and a driver with no
 *   person yet must still get exactly one row.
 *
 *   THE GATHERING QUERY RUNS against the real schema. It reads eight tables
 *   that were each written for another feature, and a renamed column there
 *   would otherwise fail silently in production at four in the morning.
 *
 *   THE SCHEMA REFUSES A LEVEL IT DOES NOT KNOW.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function seed(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await h.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES (7, -1007, 'WENZE UNIT # 310 SAM RIVERA', 'driver', TRUE),
            (8, -1008, 'WENZE UNIT # 311 ALEX KIM', 'driver', TRUE)`
  );
  await h.query(
    `INSERT INTO driver_profiles (group_id, first_name, last_name, driver_type, status, unit_number)
     VALUES (7, 'SAM', 'RIVERA', 'company_driver', 'active', '310'),
            (8, 'ALEX', 'KIM', 'company_driver', 'active', '311')`
  );
  return h;
}

const loadStore = (h) => h.loadDataLayer(['retentionAssessments']);
const loadInputs = (h) => h.loadDataLayer(['retention']);

test('the gathering query runs against the real schema and returns one row per active driver chat', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { retention } = loadInputs(h);

  const rows = await retention.gatherRetentionInputs();
  assert.equal(rows.length, 2, 'both active driver chats');
  const sam = rows.find((r) => r.groupId === 7);
  assert.equal(sam.driverName, 'SAM RIVERA');
  // Nothing is wrong yet, so every count is zero rather than null.
  assert.equal(sam.quitSignals, 0);
  assert.equal(sam.complaints, 0);
  assert.equal(sam.unpaidBonusUsd, 0);
  assert.equal(sam.roadWeeksOverAllowance, 0);
});

test('an inactive chat and a non-driver chat are not in the fleet', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  await h.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES (9, -1009, 'GONE', 'driver', FALSE),
            (10, -1010, 'HR Personnel', 'management', TRUE)`
  );
  const { retention } = loadInputs(h);
  const ids = (await retention.gatherRetentionInputs()).map((r) => r.groupId).sort();
  assert.deepEqual(ids, [7, 8]);
});

test('a driver past the road allowance is counted in WEEKS OVER, not raw days', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  // 50 days on the road against a 4-week allowance: 7 whole weeks, 3 over.
  await h.query(
    `INSERT INTO driver_home_status (group_id, state, state_since, last_status_at)
     VALUES (7, 'road', NOW() - INTERVAL '50 days', NOW() - INTERVAL '50 days')`
  );
  const { retention } = loadInputs(h);
  const sam = (await retention.gatherRetentionInputs()).find((r) => r.groupId === 7);
  assert.equal(sam.roadWeeksOverAllowance, 3);
  assert.equal(sam.daysOnRoad, 50);
});

test('a driver AT HOME has no road clock, however long the state has been set', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  await h.query(
    `INSERT INTO driver_home_status (group_id, state, state_since, last_status_at)
     VALUES (7, 'home', NOW() - INTERVAL '90 days', NOW() - INTERVAL '90 days')`
  );
  const { retention } = loadInputs(h);
  const sam = (await retention.gatherRetentionInputs()).find((r) => r.groupId === 7);
  assert.equal(sam.roadWeeksOverAllowance, 0, 'they are not on the road');
  assert.equal(sam.daysOnRoad, 0);
});

test('earned road bonus that was never posted is counted in dollars', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  await h.query(
    `INSERT INTO driver_road_history
       (group_id, road_started_at, home_arrived_at, days_on_road, bonus_usd, bonus_posted_at)
     VALUES (7, NOW() - INTERVAL '60 days',  NOW() - INTERVAL '10 days',  50, 200, NULL),
            (7, NOW() - INTERVAL '120 days', NOW() - INTERVAL '70 days',  50, 100, NULL),
            (7, NOW() - INTERVAL '200 days', NOW() - INTERVAL '150 days', 50, 300, NOW())`
  );
  const { retention } = loadInputs(h);
  const sam = (await retention.gatherRetentionInputs()).find((r) => r.groupId === 7);
  assert.equal(sam.unpaidBonusUsd, 300, 'the posted one does not count');
});

test('home requests that expired unanswered are counted apart from ones that were declined', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  await h.query(
    `INSERT INTO home_time_requests (group_id, status, requested_at)
     VALUES (7, 'expired', NOW() - INTERVAL '10 days'),
            (7, 'clarification_unanswered', NOW() - INTERVAL '20 days'),
            (7, 'denied', NOW() - INTERVAL '5 days'),
            (7, 'approved', NOW() - INTERVAL '5 days'),
            (7, 'expired', NOW() - INTERVAL '200 days')`
  );
  const { retention } = loadInputs(h);
  const sam = (await retention.gatherRetentionInputs()).find((r) => r.groupId === 7);
  assert.equal(sam.unansweredHomeRequests, 2, 'and the 200-day-old one is out of the window');
  assert.equal(sam.deniedHomeRequests, 1);
});

test('what a driver SAID is read through chat_logs, which is where the annotations hang', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  await h.query(
    `INSERT INTO chat_logs (id, group_id, message_text, created_at)
     VALUES (1, 7, 'I am done with this', NOW() - INTERVAL '2 days'),
            (2, 7, 'still no pay',        NOW() - INTERVAL '3 days'),
            (3, 7, 'ok',                  NOW() - INTERVAL '4 days'),
            (4, 8, 'I am done too',       NOW() - INTERVAL '2 days')`
  );
  await h.query(
    `INSERT INTO chat_message_annotations (chat_log_id, intent, sentiment)
     VALUES (1, 'quit_signal', -2),
            (2, 'complaint',   -1),
            (3, 'acknowledgement', 0),
            (4, 'quit_signal', -2)`
  );
  const { retention } = loadInputs(h);
  const rows = await retention.gatherRetentionInputs();
  const sam = rows.find((r) => r.groupId === 7);
  assert.equal(sam.quitSignals, 1, "another driver's message must not land here");
  assert.equal(sam.complaints, 1);
  assert.equal(Math.round(sam.avgSentiment * 100) / 100, -1);
});

test('a driver whose messages were never annotated has a NULL sentiment, not a neutral one', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  await h.query(
    "INSERT INTO chat_logs (id, group_id, message_text, created_at) VALUES (1, 7, 'hello', NOW())"
  );
  const { retention } = loadInputs(h);
  const sam = (await retention.gatherRetentionInputs()).find((r) => r.groupId === 7);
  assert.equal(sam.avgSentiment, null, '"never measured" is not "felt neutral"');
});

// ── the assessment store ────────────────────────────────────────────────────

test('one assessment per person, updated rather than accumulated', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { retentionAssessments: store } = loadStore(h);

  await store.recordAssessment({ personId: 11, groupId: 7, driverName: 'Sam', score: 4, level: 'watch', signals: [{ key: 'a' }], actions: ['Ring them'] });
  const second = await store.recordAssessment({ personId: 11, groupId: 7, driverName: 'Sam', score: 9, level: 'urgent', signals: [{ key: 'b' }], actions: [] });

  assert.equal(second.score, 9);
  assert.equal(second.level, 'urgent');
  const { rows } = await h.query('SELECT COUNT(*)::int AS n FROM driver_retention_assessments');
  assert.equal(rows[0].n, 1);
});

test('a driver with no person yet still gets exactly one row', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { retentionAssessments: store } = loadStore(h);
  await store.recordAssessment({ personId: null, groupId: 7, driverName: 'Sam', score: 4, level: 'watch' });
  await store.recordAssessment({ personId: null, groupId: 7, driverName: 'Sam', score: 5, level: 'watch' });
  const { rows } = await h.query('SELECT COUNT(*)::int AS n FROM driver_retention_assessments');
  assert.equal(rows[0].n, 1);
});

test('a person and a group are alternative identities, not a pair', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { retentionAssessments: store } = loadStore(h);
  // Two different drivers, one identified by person and one only by chat.
  await store.recordAssessment({ personId: 11, groupId: 7, driverName: 'Sam', score: 4, level: 'watch' });
  await store.recordAssessment({ personId: null, groupId: 8, driverName: 'Alex', score: 4, level: 'watch' });
  const { rows } = await h.query('SELECT COUNT(*)::int AS n FROM driver_retention_assessments');
  assert.equal(rows[0].n, 2);
});

test('what was announced survives a later assessment', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { retentionAssessments: store } = loadStore(h);
  const row = await store.recordAssessment({ personId: 11, groupId: 7, driverName: 'Sam', score: 9, level: 'urgent' });
  await store.markNotified(row.id, 9);
  const after = await store.recordAssessment({ personId: 11, groupId: 7, driverName: 'Sam', score: 9, level: 'urgent' });
  assert.equal(after.notifiedScore, 9, 'the next pass must not forget what was said');
  assert.ok(after.notifiedAt);
});

test('the schema refuses a level it does not know', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  await assert.rejects(
    () => h.query(
      "INSERT INTO driver_retention_assessments (group_id, level) VALUES (7, 'doomed')"
    ),
    /level/,
  );
});

test('the list an operator reads is worst first and excludes the calm', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { retentionAssessments: store } = loadStore(h);
  await store.recordAssessment({ personId: 11, driverName: 'Sam', score: 5, level: 'watch' });
  await store.recordAssessment({ personId: 12, driverName: 'Alex', score: 11, level: 'urgent' });
  await store.recordAssessment({ personId: 13, driverName: 'Calm', score: 0, level: 'none' });

  const list = await store.listAssessments();
  assert.deepEqual(list.map((a) => a.driverName), ['Alex', 'Sam']);

  const summary = await store.summariseRetention();
  assert.equal(summary.urgent, 1);
  assert.equal(summary.watch, 1);
});

test('acknowledging is reversible and never deletes the history', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { retentionAssessments: store } = loadStore(h);
  const row = await store.recordAssessment({ personId: 11, driverName: 'Sam', score: 9, level: 'urgent', signals: [{ key: 'a' }] });
  const acked = await store.acknowledge(row.id, 'boss');
  assert.ok(acked.acknowledgedAt);
  assert.equal(acked.acknowledgedBy, 'boss');
  const cleared = await store.acknowledge(row.id, null);
  assert.equal(cleared.acknowledgedAt, null);
  assert.deepEqual(cleared.signals, [{ key: 'a' }], 'the assessment itself is untouched');
});

test('the retention capability is registered and cannot self-apply', async (t) => {
  if (await skipWithoutPg(t)) return;
  const h = await seed(t);
  const { rows } = await h.query(
    'SELECT * FROM ai_capabilities WHERE capability_key = $1', ['retention_summary']
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sends_raw_text, false, 'counts and reasons only — no name, no message text');
  assert.equal(rows[0].has_deterministic_fallback, true);
  assert.equal(rows[0].may_auto_apply, false);
});
