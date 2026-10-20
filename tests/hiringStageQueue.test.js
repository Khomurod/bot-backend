'use strict';

/**
 * services/hiringStages/conversationQueue.js — which captured messages queue a
 * conversation, and under which post. Only General, only with the switch on,
 * only a reply; the chain is followed back to the post, and an album is named
 * by its first item. Ids are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
function stub(rel, exports) {
  const filename = require.resolve(path.resolve(ROOT, rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const CHAT = '-1001234567890';
const STORED = new Map([
  [169, { messageId: 169, mediaGroupId: 'g1', replyToMessageId: null }],
  [170, { messageId: 170, mediaGroupId: 'g1', replyToMessageId: null }],
  [172, { messageId: 172, mediaGroupId: null, replyToMessageId: 170 }],
  [173, { messageId: 173, mediaGroupId: null, replyToMessageId: 172 }],
  [500, { messageId: 500, mediaGroupId: null, replyToMessageId: 499 }],
]);
let queued = [];
stub('database/safetyApprovals/messages.js', {
  getMessage: async (chatId, id) => STORED.get(Number(id)) || null,
  getMediaGroup: async (chatId, g) => [...STORED.values()].filter((m) => m.mediaGroupId === g),
});
stub('database/hiringStages/threads.js', { enqueueThread: async (row) => { queued.push(row); return { id: 1, ...row }; } });

const { noteConversationMessage, SETTLE_SECONDS } = require('../services/hiringStages/conversationQueue');

const ON = { stageProposalsEnabled: true };
const msg = (messageId, over = {}) => ({ chatId: CHAT, messageId, threadId: null, replyToMessageId: null, ...over });

test('a reply deep in a conversation queues the album\'s FIRST item, replying to the newest message', async () => {
  queued = [];
  const row = await noteConversationMessage(msg(174, { replyToMessageId: 173 }), ON);
  assert.deepEqual(queued, [{ chatId: CHAT, rootMessageId: 169, lastMessageId: 174, settleSeconds: SETTLE_SECONDS }]);
  assert.ok(row);
});

test('nothing is queued: switched off, another topic, not a reply, or a post the bot never saw', async () => {
  queued = [];
  assert.equal(await noteConversationMessage(msg(174, { replyToMessageId: 173 }), { stageProposalsEnabled: false }), null);
  assert.equal(await noteConversationMessage(msg(174, { replyToMessageId: 173, threadId: 3 }), ON), null);
  assert.equal(await noteConversationMessage(msg(174), ON), null);
  assert.equal(await noteConversationMessage(msg(501, { replyToMessageId: 500 }), ON), null);
  assert.deepEqual(queued, []);
});
