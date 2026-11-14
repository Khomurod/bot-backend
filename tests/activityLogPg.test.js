'use strict';

/**
 * The activity log against the real schema (migration 0105): an entry as the
 * recorder writes it, the page the Logs screen reads (newest first, filters,
 * the cursor), the owner's notice when Bitrix keeps saying no, and retention
 * — names out after 60 days with the ids kept, rows gone after a year.
 * Names and numbers are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { bitrixWriteEntry, attemptEntry } = require('../lib/activityLog/entry');

const ALL_MIGRATIONS = allMigrationsSql();
const daysAgo = (n) => `NOW() - INTERVAL '${n} days'`;

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = h.loadDataLayer(['activityLog', 'operationalNotifications', 'pool']);
  return { h, store: layer.activityLog, notices: layer.operationalNotifications, query: layer.pool.query };
}

const stageWrite = (over = {}) => bitrixWriteEntry({
  method: 'crm.deal.update',
  params: { id: 321, fields: { STAGE_ID: 'C9:H' } },
  audit: {
    actorKind: 'person_button', actorTelegramId: 777, actorName: 'Dina', trigger: 'board_bitrix.button',
    reason: 'Pressed a button', evidence: { questionId: 5, driverName: 'ALAN BROWN' }, targetLabel: 'ALAN BROWN',
    change: [{ field: 'TITLE', from: 'No name', to: 'ALAN BROWN' }, { field: 'STAGE_ID', from: 'C9:W', to: 'C9:H' }],
  },
  result: true,
  ...over,
});

test('an entry round-trips; the page is newest first, filtered, and pages by cursor', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  const first = await store.insertEntry(stageWrite());
  assert.ok(first.id > 0);
  for (let i = 0; i < 55; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await store.insertEntry(attemptEntry({
      action: 'deal.stage', targetId: 400 + i, result: 'refused', error: 'the deal stage changed',
      audit: { actorKind: 'automatic', trigger: 'board_bitrix.sync' },
    }));
  }
  const page1 = await store.listEntries({});
  assert.equal(page1.entries.length, 50);
  assert.equal(page1.entries[0].targetId, '454', 'newest first');
  assert.ok(page1.nextCursor);
  const page2 = await store.listEntries({ before: page1.nextCursor });
  assert.equal(page2.entries.length, 6);
  assert.equal(page2.nextCursor, null);
  assert.equal(page2.entries[5].actorTelegramId, '777');
  assert.equal(new Set([...page1.entries, ...page2.entries].map((e) => e.id)).size, 56, 'no row twice, none lost');

  assert.equal((await store.listEntries({ trigger: 'board_bitrix.button' })).entries.length, 1);
  assert.equal((await store.listEntries({ result: 'done' })).entries.length, 1);
  assert.equal((await store.listEntries({ search: '321' })).entries.length, 1, 'by deal number');
  assert.equal((await store.listEntries({ search: 'alan' })).entries.length, 1, 'by name');
  assert.equal((await store.listEntries({ search: '100%_' })).entries.length, 0, 'LIKE wildcards are literal');
  assert.equal((await store.listEntries({ from: new Date(Date.now() + 60000).toISOString() })).entries.length, 0);

  // The streak's view skips our own safety checks' refusals (`safety_check`).
  assert.equal((await store.listEntries({ trigger: 'board_bitrix.sync' })).entries[0].safetyCheck, true);
  assert.deepEqual(await store.recentForTrigger('board_bitrix.sync', 20), []);
  const failed = await store.insertEntry(attemptEntry({
    action: 'deal.stage', targetId: 1, result: 'failed', error: 'no answer', audit: { actorKind: 'automatic', trigger: 'board_bitrix.sync' },
  }));
  assert.deepEqual(await store.recentForTrigger('board_bitrix.sync', 20), [{ id: failed.id, result: 'failed' }]);
  assert.deepEqual(await store.entryWords(failed.id), { result: 'failed', error: 'no answer', reason: null });
});

test('an unknown result or actor cannot be stored', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  await assert.rejects(store.insertEntry({ ...stageWrite(), result: 'maybe' }));
  await assert.rejects(store.insertEntry({ ...stageWrite(), actorKind: 'boss' }));
});

test('retention: names out after 60 days (ids stay), rows gone after a year', { skip: skipWithoutPg() }, async (t) => {
  const { h, store, query } = await setup(t);
  await store.insertEntry(stageWrite());
  const old = await store.insertEntry(stageWrite());
  const ancient = await store.insertEntry(stageWrite());
  await h.query(`UPDATE activity_log SET occurred_at = ${daysAgo(61)} WHERE id = $1`, [old.id]);
  await h.query(`UPDATE activity_log SET occurred_at = ${daysAgo(400)} WHERE id = $1`, [ancient.id]);

  const retention = require('../services/operations/dataRetention');
  const { deleted, errors } = await retention.runDataRetentionPass({
    deps: {
      query, activityLog: store, safety: { pruneOldSafetyEvents: async () => 0 }, aiCallLog: { pruneAiCallLog: async () => 0 },
    },
  });
  assert.deepEqual(errors, []);
  assert.equal(deleted.activityLog, 1);
  // Names go first, so the year-old row is scrubbed and then deleted in one pass.
  assert.equal(deleted.activityLogNamesRemoved, 2);

  const rows = (await h.query('SELECT id, target_id, target_label, change, evidence, names_scrubbed_at FROM activity_log ORDER BY id')).rows;
  assert.equal(rows.length, 2);
  const [fresh, scrubbed] = rows;
  assert.equal(fresh.target_label, 'ALAN BROWN');
  assert.equal(scrubbed.target_label, null);
  assert.equal(scrubbed.target_id, '321', 'the deal number stays');
  assert.deepEqual(scrubbed.change, [{ field: 'TITLE', from: null, to: null }, { field: 'STAGE_ID', from: 'C9:W', to: 'C9:H' }]);
  assert.deepEqual(scrubbed.evidence, { questionId: 5 });
  assert.ok(scrubbed.names_scrubbed_at);
  assert.equal(await store.scrubOldNames(60), 0, 'each row is rewritten once');
});

const SYNC = { actorKind: 'automatic', trigger: 'board_bitrix.sync' };
const refusedWrite = () => bitrixWriteEntry({
  method: 'crm.deal.update', params: { id: 1, fields: { STAGE_ID: 'C9:H' } }, audit: SYNC,
  error: Object.assign(new Error('Bitrix crm.deal.update: Access denied'), { retryable: false }),
});
const guardRefusal = () => attemptEntry({ action: 'deal.stage', targetId: 1, result: 'refused', audit: SYNC });

/** The real check against the real outbox; `sent` is what was enqueued. */
function outbox(notices) {
  const sent = [];
  return {
    sent,
    notify: async (n) => {
      const key = `${n.category}:${n.subjectType}:${n.subjectId}:${n.discriminator}`;
      const row = await notices.enqueueNotification({
        noticeKey: key, category: n.category, chatId: '-1001', routedVia: 'default', body: n.title, subjectType: n.subjectType, subjectId: n.subjectId,
      });
      if (row) sent.push(key);
      return { recorded: Boolean(row) };
    },
  };
}

test('three Bitrix refusals in a row: one notice; a safety check neither counts nor resets', { skip: skipWithoutPg() }, async (t) => {
  const { store, notices } = await setup(t);
  const { checkFailureStreak } = require('../services/activityLog/failureNotice');
  const box = outbox(notices);
  const deps = { store, notices, notify: box.notify };
  const first = await store.insertEntry(refusedWrite());
  await checkFailureStreak('board_bitrix.sync', deps);
  await store.insertEntry(guardRefusal());
  await store.insertEntry(refusedWrite());
  await checkFailureStreak('board_bitrix.sync', deps);
  assert.equal(box.sent.length, 0, 'two Bitrix refusals and a safety check are not three');
  await store.insertEntry(refusedWrite());
  await checkFailureStreak('board_bitrix.sync', deps);
  await store.insertEntry(refusedWrite());
  await checkFailureStreak('board_bitrix.sync', deps);
  assert.deepEqual(box.sent, [`system_errors:activity_log:board_bitrix.sync:streak:${first.id}`], 'once, keyed to the streak\'s first entry');

  // A success resets; a new streak within six hours is still quiet.
  await store.insertEntry(stageWrite({ audit: SYNC }));
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await store.insertEntry(attemptEntry({ action: 'deal.stage', targetId: 1, result: 'failed', audit: SYNC }));
    // eslint-disable-next-line no-await-in-loop
    await checkFailureStreak('board_bitrix.sync', deps);
  }
  assert.equal(box.sent.length, 1, 'at most one every six hours');
});

test('a streak held back by the quiet hours that outgrows the window is told once they end — exactly once', { skip: skipWithoutPg() }, async (t) => {
  const { h, store, notices } = await setup(t);
  const { checkFailureStreak } = require('../services/activityLog/failureNotice');
  const box = outbox(notices);
  const deps = { store, notices, notify: box.notify };
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await store.insertEntry(refusedWrite());
  }
  await checkFailureStreak('board_bitrix.sync', deps);
  assert.equal(box.sent.length, 1, 'streak A told');
  await store.insertEntry(stageWrite({ audit: SYNC }));

  // Streak B: 25 failures, every check inside the six quiet hours.
  const streakB = [];
  for (let i = 0; i < 25; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    streakB.push((await store.insertEntry(refusedWrite())).id);
    // eslint-disable-next-line no-await-in-loop
    await checkFailureStreak('board_bitrix.sync', deps);
  }
  assert.equal(box.sent.length, 1, 'quiet');
  assert.equal(await store.streakStartId('board_bitrix.sync'), streakB[0], 'the exact start, past the 20 read');

  // Seven hours later the outage goes on: the next failure tells — once.
  await h.query(`UPDATE operational_notifications SET created_at = NOW() - INTERVAL '7 hours'`);
  await store.insertEntry(refusedWrite());
  const told = await checkFailureStreak('board_bitrix.sync', deps);
  assert.equal(told.notified, true, told.why);
  assert.equal(box.sent[1], `system_errors:activity_log:board_bitrix.sync:streak:${streakB[0]}`);
  await h.query(`UPDATE operational_notifications SET created_at = NOW() - INTERVAL '7 hours'`);
  await store.insertEntry(refusedWrite());
  const again = await checkFailureStreak('board_bitrix.sync', deps);
  assert.equal(again.notified, false);
  assert.match(again.why, /already told about this streak/);
  assert.equal(box.sent.length, 2);
});
