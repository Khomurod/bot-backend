'use strict';

/**
 * services/safetyApprovals/captureService.js — the quiet listener. Only the
 * configured group is stored; only the people named as Safety queue a review;
 * nothing it does can throw at the bot. Ids are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
function stub(rel, exports) {
  const filename = require.resolve(path.resolve(ROOT, rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let stored = [];
let queued = [];
let marked = [];
let failUpsert = false;

stub('database/safetyApprovals/settings.js', {
  getSafetyApprovalSettings: async () => SETTINGS,
  markRecruitmentGroup: async (chatId) => { marked.push(chatId); return 1; },
});
stub('database/safetyApprovals/messages.js', {
  upsertMessage: async (m) => {
    if (failUpsert) throw new Error('database is down');
    stored = stored.filter((r) => r.messageId !== m.messageId).concat([{ ...m, fromUserId: String(m.fromUserId) }]);
    return { id: stored.length, created: true };
  },
  getMediaGroup: async (chatId, mg) => stored.filter((r) => r.mediaGroupId === mg),
});
stub('database/safetyApprovals/reviews.js', {
  enqueueReview: async (r) => { queued.push(r); return { id: queued.length, ...r }; },
});
stub('services/safetyApprovals/worker.js', { wakeSafetyApprovalWorker: () => {} });

const { captureSafetyApprovalMessage, SETTLE_SECONDS, __resetForTests } = require('../services/safetyApprovals/captureService');

const CHAT = -1001234567890;
const SETTINGS = { enabled: true, chatId: String(CHAT), topicId: 45, safetyUserIds: ['900'] };
let wakes = 0;
const capture = (message) => captureSafetyApprovalMessage(message, { wake: () => { wakes += 1; } });

function reset() {
  stored = []; queued = []; marked = []; wakes = 0; failUpsert = false;
  __resetForTests();
}

const message = (fields) => ({ message_id: 1, chat: { id: CHAT }, from: { id: 500 }, date: 1760000000, ...fields });

test('another chat leaves no trace at all', async () => {
  reset();
  const out = await capture(message({ chat: { id: -100999 }, text: 'Renata Ilves 555-010-7788' }));
  assert.equal(out.captured, false);
  assert.equal(stored.length, 0);
  assert.equal(marked.length, 0);
});

test('a recruiter\'s post is stored, the group leaves the driver features, nothing is queued', async () => {
  reset();
  const out = await capture(message({ message_id: 10, text: 'Renata Ilves 555-010-7788' }));
  assert.deepEqual(out, { captured: true });
  assert.equal(stored[0].text, 'Renata Ilves 555-010-7788');
  assert.deepEqual(marked, [String(CHAT)]);
  await capture(message({ message_id: 11, text: 'more' }));
  assert.equal(marked.length, 1, 'the group is marked once per process');
  assert.equal(queued.length, 0);
});

test('a Safety DECISION queues a review of the post it answers, after the settle delay', async () => {
  reset();
  const out = await capture(message({
    message_id: 20, from: { id: 900 }, text: '#Approved', reply_to_message: { message_id: 10 },
  }));
  assert.equal(out.queued, true);
  assert.deepEqual(queued[0], {
    chatId: String(CHAT), safetyKey: 'message:20', safetyUserId: 900, postMessageId: 10, settleSeconds: SETTLE_SECONDS,
  });
  assert.equal(wakes, 1);
});

test('a decision written on its own is queued too, with no post yet — it is never dropped', async () => {
  reset();
  await capture(message({ message_id: 30, from: { id: 900 }, text: 'driver was at fault, not approved' }));
  await capture(message({ message_id: 31, from: { id: 900 }, text: 'Looks good, we can hire him' }));
  assert.deepEqual(queued.map((q) => [q.safetyKey, q.postMessageId]), [['message:30', null], ['message:31', null]]);
});

test('an album is queued once the item with the words arrives, and each later item re-arms it', async () => {
  reset();
  await capture(message({
    message_id: 20, from: { id: 900 }, media_group_id: 's1', reply_to_message: { message_id: 10 },
    document: { file_id: 'psp', file_name: 'PSP.pdf', mime_type: 'application/pdf' },
  }));
  assert.equal(queued.length, 0, 'a PDF on its own is not a decision');
  await capture(message({
    message_id: 21, from: { id: 900 }, media_group_id: 's1', caption: '#NotApproved',
    document: { file_id: 'mvr', file_name: 'MVR.pdf', mime_type: 'application/pdf' },
  }));
  await capture(message({
    message_id: 22, from: { id: 900 }, media_group_id: 's1',
    document: { file_id: 'clh', file_name: 'CLH.pdf', mime_type: 'application/pdf' },
  }));
  assert.deepEqual(queued.map((q) => [q.safetyKey, q.postMessageId]), [['album:s1', 10], ['album:s1', 10]]);
});

test('NO TOKENS FOR CHATTER: "on it", "CLH sent", a recruiter, and bots queue nothing', async () => {
  reset();
  await capture(message({ message_id: 30, from: { id: 900 }, text: 'on it', reply_to_message: { message_id: 10 } }));
  await capture(message({ message_id: 31, from: { id: 900 }, text: 'CLH sent', reply_to_message: { message_id: 10 } }));
  await capture(message({ message_id: 32, from: { id: 500 }, text: 'is he approved?', reply_to_message: { message_id: 10 } }));
  await capture(message({ message_id: 33, from: { id: 777, is_bot: true }, text: '#Approved', reply_to_message: { message_id: 10 } }));
  assert.equal(queued.length, 0);
  assert.equal(stored.length, 3, 'a bot\'s message is not stored');
});

test('a database failure is a reason, never an exception at the bot', async () => {
  reset();
  failUpsert = true;
  const out = await capture(message({ message_id: 40, text: 'x' }));
  assert.deepEqual(out, { captured: false, reason: 'error' });
});
