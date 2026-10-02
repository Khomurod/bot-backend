/**
 * Following a moved Telegram group, against a real PostgreSQL.
 *
 * Shaped on production, 2026-10-02: the managers' home-time chat (a basic
 * group) was upgraded to a supergroup, and every setting naming it kept the
 * dead id.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const OLD = '-5052301861';
const NEW = '-1001234567890';
const OTHER = '-1009999999999';

async function seeded(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await h.query(`UPDATE home_time_settings SET completed_notify_group_id = $1, internal_clarification_group_id = $1 WHERE id = 1`, [OLD]);
  await h.query(`UPDATE message_group_settings SET raise_results_group_id = $1, mileage_bonus_group_id = $2 WHERE id = 1`, [OLD, OTHER]);
  await h.query(
    `UPDATE operational_notification_settings SET default_chat_id = $2,
       category_chat_ids = jsonb_build_object('fuel', $1::text, 'finance', $2::text) WHERE id = 1`,
    [OLD, OTHER]
  );
  await h.query(`INSERT INTO bol_pod_forwarding_settings (id, central_group_id) VALUES (1, $1::bigint)
                 ON CONFLICT (id) DO UPDATE SET central_group_id = EXCLUDED.central_group_id`, [OLD]);
  await h.query(`INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
                 VALUES (230835, $1::bigint, 'HR Personnel', 'company', TRUE)`, [OLD]);
  // Three notices: one still pending, one failed yesterday, one failed a week ago.
  const ins = `INSERT INTO home_time_manager_notices (event_key, event_type, chat_id, body, state, attempts, last_error, created_at)
               VALUES ($1, 'arrived_home', $2, 'b', $3, $4, $5, NOW() - ($6 || ' hours')::interval)`;
  await h.query(ins, ['arrived_home:1', OLD, 'pending', 2, 'upgraded', '1']);
  await h.query(ins, ['arrived_home:2', OLD, 'failed', 6, 'upgraded', '20']);
  await h.query(ins, ['arrived_home:3', OLD, 'failed', 6, 'upgraded', '170']);
  return h;
}

test('every setting, the group row and the queued notices move to the new id — and nothing else',
  { skip: skipWithoutPg() }, async (t) => {
    const h = await seeded(t);
    const { telegramChatMigration: m } = h.loadDataLayer(['telegramChatMigration']);
    const out = await m.followChatMigration(OLD, NEW);

    const ht = (await h.query('SELECT completed_notify_group_id AS a, internal_clarification_group_id AS b FROM home_time_settings')).rows[0];
    assert.deepEqual(ht, { a: NEW, b: NEW }, 'the managers\' chat — the production failure');
    const mg = (await h.query('SELECT raise_results_group_id AS r, mileage_bonus_group_id AS m FROM message_group_settings')).rows[0];
    assert.deepEqual(mg, { r: NEW, m: OTHER }, 'a different chat is left alone');
    const ns = (await h.query('SELECT default_chat_id AS d, category_chat_ids AS c FROM operational_notification_settings')).rows[0];
    assert.equal(ns.d, OTHER);
    assert.deepEqual(ns.c, { fuel: NEW, finance: OTHER }, 'only the routing entry naming the old chat moves');
    const bol = (await h.query('SELECT central_group_id::text AS c FROM bol_pod_forwarding_settings')).rows[0];
    assert.equal(bol.c, NEW, 'a BIGINT column moves too');
    const g = (await h.query('SELECT telegram_group_id::text AS id FROM groups WHERE id = 230835')).rows[0];
    assert.equal(g.id, NEW);

    const notices = (await h.query('SELECT event_key, chat_id, state, attempts FROM home_time_manager_notices ORDER BY event_key')).rows;
    assert.deepEqual(notices, [
      { event_key: 'arrived_home:1', chat_id: NEW, state: 'pending', attempts: 2 },
      { event_key: 'arrived_home:2', chat_id: NEW, state: 'pending', attempts: 0 },
      { event_key: 'arrived_home:3', chat_id: NEW, state: 'failed', attempts: 6 },
    ], 'the recent failure is resent; the week-old one is NOT replayed into a live chat');
    assert.equal(out.requeued, 1);
    assert.equal(out.pointed, 3);

    const audit = (await h.query(`SELECT action, entity_id FROM admin_audit_log WHERE action = 'telegram.chat_migrated'`)).rows;
    assert.deepEqual(audit, [{ action: 'telegram.chat_migrated', entity_id: OLD }], 'one audit row');
  });

test('a second call for the same move changes nothing and writes no second audit row',
  { skip: skipWithoutPg() }, async (t) => {
    const h = await seeded(t);
    const { telegramChatMigration: m } = h.loadDataLayer(['telegramChatMigration']);
    await m.followChatMigration(OLD, NEW);
    const again = await m.followChatMigration(OLD, NEW);
    assert.equal(again.nothingToDo, true);
    const n = (await h.query(`SELECT COUNT(*)::int AS n FROM admin_audit_log WHERE action = 'telegram.chat_migrated'`)).rows[0].n;
    assert.equal(n, 1);
  });

test('when the new group is already a separate row, the old row is left and the conflict reported',
  { skip: skipWithoutPg() }, async (t) => {
    const h = await seeded(t);
    await h.query(`INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
                   VALUES (999001, $1::bigint, 'HR Personnel', 'company', TRUE)`, [NEW]);
    const { telegramChatMigration: m } = h.loadDataLayer(['telegramChatMigration']);
    const out = await m.followChatMigration(OLD, NEW);
    assert.equal(out.groupMoved, 0);
    assert.equal(out.groupConflict, true);
    const ht = (await h.query('SELECT completed_notify_group_id AS a FROM home_time_settings')).rows[0];
    assert.equal(ht.a, NEW, 'the settings still move — the conflict is only about the group record');
  });

test('nonsense ids change nothing', { skip: skipWithoutPg() }, async (t) => {
  const h = await seeded(t);
  const { telegramChatMigration: m } = h.loadDataLayer(['telegramChatMigration']);
  assert.equal((await m.followChatMigration(OLD, OLD)).nothingToDo, true);
  assert.equal((await m.followChatMigration(OLD, 'abc')).nothingToDo, true);
});

test('the destinations to ask about are every configured chat, once each', { skip: skipWithoutPg() }, async (t) => {
  const h = await seeded(t);
  const { telegramChatMigration: m } = h.loadDataLayer(['telegramChatMigration']);
  const ids = (await m.listDestinationChatIds()).sort();
  assert.deepEqual(ids, [OTHER, OLD].sort());
});

test('the AI terms-watcher alerts move with their chat — an unsent one gets its attempts back',
  { skip: skipWithoutPg() }, async (t) => {
    const h = await seeded(t);
    const f1 = (await h.query(`INSERT INTO ai_policy_findings (source_url, summary) VALUES ('https://x.test', 'a') RETURNING id`)).rows[0].id;
    const f2 = (await h.query(`INSERT INTO ai_policy_findings (source_url, summary) VALUES ('https://x.test', 'b') RETURNING id`)).rows[0].id;
    await h.query(`INSERT INTO ai_policy_alert_outbox (finding_id, chat_id, body, attempts, last_error) VALUES ($1, $2, 'b', 6, 'upgraded')`, [f1, OLD]);
    await h.query(`INSERT INTO ai_policy_alert_outbox (finding_id, chat_id, body, attempts, sent_at) VALUES ($1, $2, 'b', 1, NOW())`, [f2, OLD]);
    const { telegramChatMigration: m } = h.loadDataLayer(['telegramChatMigration']);
    await m.followChatMigration(OLD, NEW);
    const rows = (await h.query('SELECT finding_id, chat_id, attempts, sent_at IS NOT NULL AS sent FROM ai_policy_alert_outbox ORDER BY finding_id')).rows;
    assert.deepEqual(rows, [
      { finding_id: f1, chat_id: NEW, attempts: 0, sent: false },
      { finding_id: f2, chat_id: OLD, attempts: 1, sent: true },
    ], 'the unsent alert follows the move and is retried; a delivered one is history and stays as it was');
  });

test('a repeated call never revives a notice that failed on the NEW chat for another reason',
  { skip: skipWithoutPg() }, async (t) => {
    const h = await seeded(t);
    await h.query(
      `INSERT INTO home_time_manager_notices (event_key, event_type, chat_id, body, state, attempts, last_error)
       VALUES ('back_on_road:9', 'back_on_road', $1, 'b', 'failed', 6, '403: Forbidden: bot was kicked')`, [NEW]
    );
    const { telegramChatMigration: m } = h.loadDataLayer(['telegramChatMigration']);
    await m.followChatMigration(OLD, NEW);
    await m.followChatMigration(OLD, NEW);
    const row = (await h.query(`SELECT state, attempts FROM home_time_manager_notices WHERE event_key = 'back_on_road:9'`)).rows[0];
    assert.deepEqual(row, { state: 'failed', attempts: 6 }, 'somebody else\'s failure is left alone');
  });
