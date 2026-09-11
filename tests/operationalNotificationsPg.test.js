/**
 * The notification settings and outbox against a real PostgreSQL.
 *
 * The promise worth a database to prove is the one an in-memory guard cannot
 * make: A NOTICE IS SENT ONCE. Background checks re-derive the same condition
 * every few minutes and Render restarts this process several times a day, so
 * the guarantee is `notice_key UNIQUE` plus `ON CONFLICT DO NOTHING`, which is
 * a claim about SQL rather than about JavaScript.
 *
 * The rest is the outbox contract that three earlier queues earned the hard
 * way: attempts counted at claim time, the backoff computed from the row's own
 * counter, and a terminal state rather than retrying forever.
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

const load = (h) => h.loadDataLayer(['operationalNotifications', 'operationalNotificationSettings']);

const BASE = {
  category: 'fuel', chatId: '-100111', routedVia: 'default',
  body: 'Unit 310 may not reach its stop', subjectType: 'group', subjectId: '7',
};

// ── settings ─────────────────────────────────────────────────────────────────

test('the settings row is seeded, so a fresh install has somewhere to read from',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const { operationalNotificationSettings: s } = load(harness);
    const cfg = await s.getNotificationSettings({ fresh: true });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.defaultChatId, null, 'nothing is invented — it is configured or it is null');
    assert.deepEqual(cfg.categoryChatIds, {});
  });

test('a category override is stored, and clearing it REMOVES the key',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const { operationalNotificationSettings: s } = load(harness);

    await s.updateNotificationSettings({ defaultChatId: '-100111', categoryChatIds: { fuel: '-100222' } });
    let cfg = await s.getNotificationSettings({ fresh: true });
    assert.equal(cfg.categoryChatIds.fuel, '-100222');

    // Clearing must DELETE rather than store an empty string: an empty string
    // read back as a destination would send this category nowhere.
    await s.updateNotificationSettings({ categoryChatIds: { fuel: '' } });
    cfg = await s.getNotificationSettings({ fresh: true });
    assert.equal('fuel' in cfg.categoryChatIds, false);
    assert.equal(cfg.defaultChatId, '-100111', 'the other fields were untouched');
  });

test('a patch touching one section does not blank another', { skip: skipWithoutPg() }, async (t) => {
  const harness = await seed(t);
  const { operationalNotificationSettings: s } = load(harness);
  await s.updateNotificationSettings({
    defaultChatId: '-100111', categoryChatIds: { fuel: '-100222' }, repeatAfterHours: 24,
  });
  await s.updateNotificationSettings({ categoryChatIds: { retention: '-100333' } });
  const cfg = await s.getNotificationSettings({ fresh: true });
  assert.equal(cfg.defaultChatId, '-100111');
  assert.equal(cfg.repeatAfterHours, 24);
  assert.deepEqual(cfg.categoryChatIds, { fuel: '-100222', retention: '-100333' });
});

test('an unknown category is refused rather than stored forever', { skip: skipWithoutPg() }, async (t) => {
  const harness = await seed(t);
  const { operationalNotificationSettings: s } = load(harness);
  await assert.rejects(
    () => s.updateNotificationSettings({ categoryChatIds: { fuell: '-100222' } }),
    /Unknown notification category/
  );
});

test('a nonsense repeat window is clamped to the CHECK, not rejected by it',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const { operationalNotificationSettings: s } = load(harness);
    await s.updateNotificationSettings({ repeatAfterHours: 999999 });
    assert.equal((await s.getNotificationSettings({ fresh: true })).repeatAfterHours, 8760);
    await s.updateNotificationSettings({ repeatAfterHours: -5 });
    assert.equal((await s.getNotificationSettings({ fresh: true })).repeatAfterHours, 1);
  });

// ── saying a thing once ──────────────────────────────────────────────────────

test('the same notice enqueued twice is stored once', { skip: skipWithoutPg() }, async (t) => {
  const harness = await seed(t);
  const { operationalNotifications: n } = load(harness);

  const first = await n.enqueueNotification({ ...BASE, noticeKey: 'fuel:group:7:stop-442' });
  const second = await n.enqueueNotification({
    ...BASE, noticeKey: 'fuel:group:7:stop-442', body: 'different words, same event',
  });

  assert.ok(first);
  assert.equal(second, null, 'the second call creates nothing — and so sends nothing');
  const rows = await harness.query('SELECT body FROM operational_notifications');
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].body, 'Unit 310 may not reach its stop', 'the first body stands');
});

test('a different event on the same driver is its own notice', { skip: skipWithoutPg() }, async (t) => {
  const harness = await seed(t);
  const { operationalNotifications: n } = load(harness);
  await n.enqueueNotification({ ...BASE, noticeKey: 'fuel:group:7:stop-442' });
  await n.enqueueNotification({ ...BASE, noticeKey: 'fuel:group:7:stop-901' });
  const rows = await harness.query('SELECT COUNT(*)::int AS c FROM operational_notifications');
  assert.equal(rows.rows[0].c, 2);
});

test('an enqueue inside a transaction rolls back with it', { skip: skipWithoutPg() }, async (t) => {
  const harness = await seed(t);
  const { operationalNotifications: n } = load(harness);
  const client = await harness.connect();
  try {
    await client.query('BEGIN');
    await n.enqueueNotification({ ...BASE, noticeKey: 'fuel:group:7:rolled-back' }, client);
    await client.query('ROLLBACK');
  } finally { client.release(); }
  const rows = await harness.query('SELECT COUNT(*)::int AS c FROM operational_notifications');
  assert.equal(rows.rows[0].c, 0, 'a rolled-back change must not leave somebody notified about it');
});

// ── the outbox contract ──────────────────────────────────────────────────────

test('claiming counts the attempt, so a crash mid-send stays bounded',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const { operationalNotifications: n } = load(harness);
    const row = await n.enqueueNotification({ ...BASE, noticeKey: 'k1' });
    assert.equal(row.attempts, 0);
    const claimed = await n.claimNotificationById(row.id);
    assert.equal(claimed.attempts, 1, 'counted at claim, not at failure');
    // And a second claim finds nothing, because the lease holds.
    const due = await n.claimDueNotifications({ limit: 10 });
    assert.equal(due.length, 0);
  });

test('a failure backs off, and the delay comes from the row\'s own counter',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const { operationalNotifications: n } = load(harness);
    const row = await n.enqueueNotification({ ...BASE, noticeKey: 'k2' });
    await n.claimNotificationById(row.id);
    const failed = await n.markNotificationFailed(row.id, 'Bad Request: chat not found');
    assert.equal(failed.state, 'pending', 'still retryable');
    assert.match(failed.lastError, /chat not found/);
    const when = await harness.query(
      'SELECT next_attempt_at > NOW() AS later FROM operational_notifications WHERE id = $1',
      [row.id]
    );
    assert.equal(when.rows[0].later, true);
  });

test('a failure on the VERY FIRST attempt does not violate NOT NULL',
  { skip: skipWithoutPg() }, async (t) => {
    // PostgreSQL arrays are 1-based: an attempts of 0 indexes nothing, the
    // ladder yields NULL, and NOW() + NULL breaks next_attempt_at NOT NULL.
    const harness = await seed(t);
    const { operationalNotifications: n } = load(harness);
    const row = await n.enqueueNotification({ ...BASE, noticeKey: 'k3' });
    const failed = await n.markNotificationFailed(row.id, 'boom');
    assert.equal(failed.state, 'pending');
  });

test('a notice that burns every attempt reaches a terminal state and is COUNTED',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const { operationalNotifications: n } = load(harness);
    const row = await n.enqueueNotification({ ...BASE, noticeKey: 'k4' });
    await harness.query(
      'UPDATE operational_notifications SET attempts = $2 WHERE id = $1',
      [row.id, n.MAX_ATTEMPTS]
    );
    const settled = await n.markNotificationFailed(row.id, 'gave up');
    assert.equal(settled.state, 'abandoned');
    const summary = await n.summariseNotifications();
    assert.equal(summary.abandoned, 1, 'visible on /api/health — this is how 101 alerts were lost');
  });

test('a row stuck pending at max attempts is reaped rather than hiding forever',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const { operationalNotifications: n } = load(harness);
    const row = await n.enqueueNotification({ ...BASE, noticeKey: 'k5' });
    // The shape a worker leaves behind when it dies after claiming its last try:
    // pending, out of attempts, so every future claim skips it silently.
    await harness.query(
      'UPDATE operational_notifications SET attempts = $2 WHERE id = $1',
      [row.id, n.MAX_ATTEMPTS]
    );
    await n.claimDueNotifications({ limit: 10 });
    const after = await harness.query(
      'SELECT state FROM operational_notifications WHERE id = $1', [row.id]
    );
    assert.equal(after.rows[0].state, 'abandoned');
  });

test('a delivered notice is stamped, and the summary reports it',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const { operationalNotifications: n } = load(harness);
    const row = await n.enqueueNotification({ ...BASE, noticeKey: 'k6', personId: null, groupId: 7 });
    await n.claimNotificationById(row.id);
    const done = await n.markNotificationDelivered(row.id, { telegramMessageId: 4242 });
    assert.equal(done.state, 'delivered');
    assert.equal(done.telegramMessageId, '4242');
    const summary = await n.summariseNotifications();
    assert.equal(summary.delivered24h, 1);
    assert.equal(summary.pending, 0);
  });

test('the repeat window lets a condition that is STILL true be said again later',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const { operationalNotifications: n } = load(harness);
    const row = await n.enqueueNotification({ ...BASE, noticeKey: 'fuel:group:7:day1' });
    await n.claimNotificationById(row.id);
    await n.markNotificationDelivered(row.id, {});
    assert.equal(await n.noticeSentWithin('fuel:group:7', 168), true);
    await harness.query(
      "UPDATE operational_notifications SET delivered_at = NOW() - INTERVAL '9 days'"
    );
    assert.equal(await n.noticeSentWithin('fuel:group:7', 168), false,
      'a week later the same risk is worth mentioning again');
  });
