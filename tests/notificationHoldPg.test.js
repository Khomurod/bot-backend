/**
 * Holding a notice instead of dropping it, against a real PostgreSQL.
 *
 * Two claims that are about SQL rather than about JavaScript, and so cannot be
 * proven with a stub:
 *
 *   "WHAT HAVE WE SAID ABOUT THIS DRIVER LATELY" IS ANSWERABLE. Migration 0031
 *   created `(person_id, created_at DESC) WHERE person_id IS NOT NULL` with the
 *   comment that a later feature would want it, and then nothing ever read it.
 *   This is that feature, and the read has to be right about the window.
 *
 *   A HELD NOTICE IS STILL DELIVERED. The hold is `next_attempt_at` in the
 *   future, which means the guarantee is that `claimDueNotifications` skips it
 *   now and picks it up afterwards — a statement about the same WHERE clause
 *   the drain uses, not about the caller that set the column.
 *
 * This repository has already lost 101 alerts to a queue that gave up quietly.
 * A suppression that discarded would be that failure with a nicer name, so the
 * test that matters most here is the one that finds the held row again.
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
  await harness.query(
    `INSERT INTO driver_people (id, display_name, normalized_key)
     VALUES (11, 'A DRIVER', 'a-driver')`
  );
  return harness;
}

const load = (h) => h.loadDataLayer(['operationalNotifications']);

const BASE = {
  category: 'fuel', chatId: '-100111', routedVia: 'default',
  body: 'a fuel notice', subjectType: 'group', subjectId: '7',
};

// ── what have we said about this driver lately ───────────────────────────────

test('it finds every category of notice about one person, which is the point',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const { operationalNotifications: store } = load(harness);

    // Three different categories — the flood a notice key cannot see, because
    // each of these is correctly deduplicated against itself.
    for (const [i, category] of ['fuel', 'retention', 'load_lifecycle'].entries()) {
      // eslint-disable-next-line no-await-in-loop
      await store.enqueueNotification({
        ...BASE, category, noticeKey: `${category}:group:7:${i}`, personId: 11, groupId: 7,
      });
    }

    const recent = await store.listRecentNoticesAbout({ personId: 11, withinMinutes: 60 });
    assert.equal(recent.length, 3);
    assert.ok(recent.every((r) => r.at instanceof Date), 'each carries when it was said');
  });

test('A NOTICE ABOUT ANOTHER DRIVER IS NOT THIS DRIVER\'S MORNING',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const { operationalNotifications: store } = load(harness);
    await harness.query(
      `INSERT INTO driver_people (id, display_name, normalized_key)
       VALUES (12, 'B DRIVER', 'b-driver')`
    );
    await store.enqueueNotification({ ...BASE, noticeKey: 'a', personId: 11 });
    await store.enqueueNotification({ ...BASE, noticeKey: 'b', personId: 12 });
    await store.enqueueNotification({ ...BASE, noticeKey: 'c', personId: 12 });

    assert.equal((await store.listRecentNoticesAbout({ personId: 11 })).length, 1);
    assert.equal((await store.listRecentNoticesAbout({ personId: 12 })).length, 2);
  });

test('the window is a real window — an older notice is not part of this hour',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const { operationalNotifications: store } = load(harness);
    await store.enqueueNotification({ ...BASE, noticeKey: 'old', personId: 11 });
    await harness.query(
      "UPDATE operational_notifications SET created_at = NOW() - INTERVAL '3 hours'"
    );
    await store.enqueueNotification({ ...BASE, noticeKey: 'new', personId: 11 });

    assert.equal((await store.listRecentNoticesAbout({ personId: 11, withinMinutes: 60 })).length, 1);
    assert.equal((await store.listRecentNoticesAbout({ personId: 11, withinMinutes: 600 })).length, 2);
  });

test('a notice with no person still groups, by its group and then by its subject',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const { operationalNotifications: store } = load(harness);
    await store.enqueueNotification({ ...BASE, noticeKey: 'g', groupId: 7 });
    await store.enqueueNotification({
      ...BASE, category: 'system_errors', noticeKey: 's',
      subjectType: 'worker', subjectId: 'return_to_road',
    });

    assert.equal((await store.listRecentNoticesAbout({ groupId: 7 })).length, 1);
    assert.equal(
      (await store.listRecentNoticesAbout({ subjectType: 'worker', subjectId: 'return_to_road' })).length,
      1
    );
    assert.deepEqual(await store.listRecentNoticesAbout({}), [],
      'and nothing to group by returns nothing rather than the whole table');
  });

// ── held, then delivered ─────────────────────────────────────────────────────

test('A HELD NOTICE IS NOT DUE NOW, AND IS DUE LATER — it is never lost',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const { operationalNotifications: store } = load(harness);

    const row = await store.enqueueNotification({
      ...BASE, noticeKey: 'held', personId: 11, delaySeconds: 3600,
    });
    assert.ok(row, 'it is written down');

    const dueNow = await store.claimDueNotifications({ limit: 10 });
    assert.equal(dueNow.length, 0, 'the drain does not pick it up while it is held');

    // Time passing, expressed the only way a test can: move the row's own clock.
    await harness.query(
      "UPDATE operational_notifications SET next_attempt_at = NOW() - INTERVAL '1 minute'"
    );
    const dueLater = await store.claimDueNotifications({ limit: 10 });
    assert.equal(dueLater.length, 1, 'and it delivers once the hold expires');
    assert.equal(dueLater[0].noticeKey, 'held');
  });

test('an ordinary notice is due immediately, so the hold cannot leak into the normal path',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const { operationalNotifications: store } = load(harness);
    await store.enqueueNotification({ ...BASE, noticeKey: 'plain', personId: 11 });
    assert.equal((await store.claimDueNotifications({ limit: 10 })).length, 1);
  });

test('a negative or nonsense delay is treated as none, never as a date in the past',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const { operationalNotifications: store } = load(harness);
    await store.enqueueNotification({ ...BASE, noticeKey: 'neg', delaySeconds: -99999 });
    await store.enqueueNotification({ ...BASE, noticeKey: 'nan', delaySeconds: 'soon' });
    assert.equal((await store.claimDueNotifications({ limit: 10 })).length, 2);
  });
