'use strict';

/**
 * The Safety Approvals stores against a real PostgreSQL: migration 0069, the
 * captured messages, the review queue's lease and revision, the memory of
 * what was posted, and the settings' guarded switch. Names are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const CHAT = '-1001234567890';

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = h.loadDataLayer(['safetyApprovals/messages', 'safetyApprovals/reviews', 'safetyApprovals/settings']);
  return {
    h,
    messages: layer['safetyApprovals/messages'],
    reviews: layer['safetyApprovals/reviews'],
    settings: layer['safetyApprovals/settings'],
  };
}

const at = (iso) => new Date(iso);
function shaped(messageId, over = {}) {
  return {
    chatId: CHAT, messageId, threadId: null, mediaGroupId: null, fromUserId: 500, fromName: 'Kim R',
    text: null, photos: [], documents: [], replyToMessageId: null,
    sentAt: at('2026-10-16T12:00:00Z'), editedAt: null, ...over,
  };
}

test('off by default, and switching on needs group, topic and Safety', { skip: skipWithoutPg() }, async (t) => {
  const { h, settings } = await setup(t);
  settings.invalidateCache();
  const initial = await settings.getSafetyApprovalSettings();
  assert.equal(initial.enabled, false);
  assert.deepEqual(initial.safetyUserIds, []);

  await assert.rejects(settings.updateSafetyApprovalSettings({ enabled: true }), /Before switching/);
  const saved = await settings.updateSafetyApprovalSettings({
    chatId: CHAT, chatValidatedAt: new Date(), topicId: 45, safetyUserIds: ['900', '7000000000'], enabled: true,
  }, 5);
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.safetyUserIds, ['900', '7000000000'], 'a bigint id survives as a string');

  const moved = await settings.updateSafetyApprovalSettings({ chatId: '-100999', chatValidatedAt: new Date() });
  assert.equal(moved.enabled, false, 'another group is switched off until it is set up again');
  assert.equal(moved.topicId, null, 'a topic number from another group is not kept');

  await h.pool.query(`INSERT INTO groups (telegram_group_id, group_name, group_type) VALUES
    ($1, 'Recruiting', 'driver'), (-100555, 'Office', 'employee')`, [CHAT]);
  assert.equal(await settings.markRecruitmentGroup(CHAT), 1);
  assert.equal(await settings.markRecruitmentGroup('-100555'), 0, 'a type somebody chose is left alone');
  const { rows } = await h.pool.query('SELECT group_type FROM groups WHERE telegram_group_id = $1', [CHAT]);
  assert.equal(rows[0].group_type, 'recruitment');
});

test('a message is stored once; an edit replaces the words and keeps the reply', { skip: skipWithoutPg() }, async (t) => {
  const { messages } = await setup(t);
  const first = await messages.upsertMessage(shaped(20, { fromUserId: 900, text: 'approved', replyToMessageId: 10 }));
  assert.equal(first.created, true);
  const edit = await messages.upsertMessage(shaped(20, {
    fromUserId: 900, text: 'not approved', replyToMessageId: null, editedAt: at('2026-10-16T12:05:00Z'),
  }));
  assert.equal(edit.created, false);
  assert.equal(edit.id, first.id);
  const row = await messages.getMessage(CHAT, 20);
  assert.equal(row.text, 'not approved');
  assert.equal(row.replyToMessageId, 10);
  assert.equal(row.fromUserId, '900');
});

test('Safety\'s replies come with the rest of their album; a recruiter\'s do not count', { skip: skipWithoutPg() }, async (t) => {
  const { messages } = await setup(t);
  await messages.upsertMessage(shaped(10, { mediaGroupId: 'p1', photos: [{ file_id: 'cdl' }], text: 'Renata Ilves' }));
  await messages.upsertMessage(shaped(11, { mediaGroupId: 'p1', photos: [{ file_id: 'back' }] }));
  await messages.upsertMessage(shaped(20, {
    fromUserId: 900, mediaGroupId: 's1', replyToMessageId: 11, documents: [{ file_id: 'psp' }],
  }));
  await messages.upsertMessage(shaped(21, { fromUserId: 900, mediaGroupId: 's1', text: 'We can hire her' }));
  await messages.upsertMessage(shaped(22, { fromUserId: 501, replyToMessageId: 10, text: 'approved?' }));

  const replies = await messages.listSafetyReplies({ chatId: CHAT, postMessageIds: [10, 11], safetyUserIds: ['900'] });
  assert.deepEqual(replies.map((r) => r.messageId), [20, 21]);
  assert.deepEqual((await messages.getMediaGroup(CHAT, 'p1')).map((r) => r.messageId), [10, 11]);

  const around = await messages.listSenderMessagesAround({
    chatId: CHAT, fromUserId: '500', at: at('2026-10-16T12:02:00Z'), seconds: 180,
  });
  assert.deepEqual(around.map((r) => r.messageId), [10, 11]);
});

test('the queue: settle, lease, and a reply edited mid-read is read again', { skip: skipWithoutPg() }, async (t) => {
  const { reviews } = await setup(t);
  const queued = await reviews.enqueueReview({
    chatId: CHAT, safetyKey: 'album:s1', safetyUserId: 900, postMessageId: 11, settleSeconds: 30,
  });
  assert.equal(queued.status, 'pending');
  assert.deepEqual(await reviews.claimDueReviews(), [], 'not before it has settled');
  assert.ok(await reviews.nextReviewDueAt());

  await reviews.enqueueReview({ chatId: CHAT, safetyKey: 'album:s1', safetyUserId: 900, postMessageId: 11, settleSeconds: 0 });
  const [claimed] = await reviews.claimDueReviews();
  assert.equal(claimed.attempts, 1);
  assert.deepEqual(await reviews.claimDueReviews(), [], 'a leased row is not claimed twice');

  // Safety edits the reply while it is being read.
  await reviews.enqueueReview({ chatId: CHAT, safetyKey: 'album:s1', safetyUserId: 900, postMessageId: 11, settleSeconds: 0 });
  assert.equal(await reviews.finishReview(claimed, { status: 'published' }), false);
  const [again] = await reviews.claimDueReviews();
  assert.equal(again.id, claimed.id);
  assert.equal(again.revision, claimed.revision + 1);

  assert.equal(await reviews.retryReview(again, { delaySeconds: 0, countAttempt: false }), true);
  const [third] = await reviews.claimDueReviews();
  assert.equal(third.attempts, again.attempts, 'a wait is not a failed attempt');
  assert.equal(await reviews.finishReview(third, { status: 'unclear', outcome: { reason: 'x' } }), true);
  assert.equal(await reviews.nextReviewDueAt(), null);
  const [listed] = await reviews.listRecentReviews(5);
  assert.deepEqual([listed.status, listed.outcome], ['unclear', { reason: 'x' }]);
});

test('the right to post is reserved first, once per decision, and a refused send gives it back', { skip: skipWithoutPg() }, async (t) => {
  const { h, reviews } = await setup(t);
  const base = { chatId: CHAT, postMessageId: 10, driverKey: 'renata ilves', driverName: 'Renata Ilves', reviewId: null };

  // Two workers at once: exactly one may post.
  const [a, b] = await Promise.all([
    reviews.reserveAnnouncement({ ...base, decision: 'approved' }),
    reviews.reserveAnnouncement({ ...base, decision: 'approved' }),
  ]);
  assert.equal([a, b].filter(Boolean).length, 1);
  const held = a || b;

  // Reserved but never completed still counts as posted.
  assert.equal(await reviews.reserveAnnouncement({ ...base, decision: 'approved' }), null);
  await reviews.completeAnnouncement(held.id, [700, 701]);

  // A changed decision is posted; a refused send hands the reservation back.
  const reversed = await reviews.reserveAnnouncement({ ...base, decision: 'not_approved' });
  assert.ok(reversed);
  await reviews.releaseAnnouncement(reversed.id);
  assert.ok(await reviews.reserveAnnouncement({ ...base, decision: 'not_approved' }), 'free to post again');

  // A sent row is never released.
  await reviews.releaseAnnouncement(held.id);
  const kept = await h.pool.query('SELECT sent_at FROM safety_approval_announcements WHERE id = $1', [held.id]);
  assert.ok(kept.rows[0]?.sent_at);
  assert.ok(await reviews.reserveAnnouncement({ ...base, postMessageId: 11, decision: 'approved' }), 'another post is its own');
});

test('old captured messages are deleted', { skip: skipWithoutPg() }, async (t) => {
  const { h, messages } = await setup(t);
  await messages.upsertMessage(shaped(1, { text: 'old' }));
  await messages.upsertMessage(shaped(2, { text: 'new' }));
  await h.pool.query(`UPDATE safety_approval_messages SET captured_at = NOW() - INTERVAL '61 days' WHERE message_id = 1`);
  assert.equal(await messages.purgeOldMessages(60), 1);
  assert.equal(await messages.getMessage(CHAT, 1), null);
  assert.ok(await messages.getMessage(CHAT, 2));
});
