'use strict';

/**
 * services/hiringStages/requestQueue.js — a person's tag, taken from capture:
 * the post as the group shows it NOW (stored, refreshed from the tag's
 * `reply_to_message`, or rebuilt when the bot never saw it), the conversation
 * queued as REQUESTED with the short settle, and 👀 on the tag. In General
 * nothing but reactions. Ids are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
function stub(rel, exports) {
  const filename = require.resolve(path.resolve(ROOT, rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const CHAT = -1001234567890;
let stored = new Map();
let upserts = [];
let requests = [];
let reactions = [];
let sent = [];
stub('database/safetyApprovals/messages.js', {
  getMessage: async (chatId, id) => stored.get(Number(id)) || null,
  getMediaGroup: async (chatId, g) => [...stored.values()].filter((r) => r.mediaGroupId === g),
  upsertMessage: async (m) => {
    upserts.push(m);
    const before = stored.get(m.messageId);
    stored.set(m.messageId, { ...before, ...m, replyToMessageId: m.replyToMessageId ?? before?.replyToMessageId ?? null });
    return { id: 1, created: !before };
  },
});
stub('database/hiringStages/threads.js', {
  requestThread: async (r) => { requests.push(r); return { id: 7, ...r }; },
  enqueueThread: async () => { throw new Error('a tag is not queued as a plain message'); },
});

const { noteBotRequest, REQUEST_SETTLE_SECONDS } = require('../services/hiringStages/requestQueue');

const BOT = { id: 777000111, username: 'wenze_recruit_bot' };
const SETTINGS = {
  enabled: true, stageProposalsEnabled: true, chatId: String(CHAT), topicId: 3, bitrixTopicId: 77, safetyUserIds: ['900'],
};
const telegram = {
  setMessageReaction: async (chatId, messageId, reaction) => { reactions.push(`${messageId}:${reaction[0].emoji}`); return true; },
  sendMessage: async (...args) => { sent.push(args); return { message_id: 1 }; },
};
const KIM = { id: 500, first_name: 'Kim', is_bot: false };

function reset() {
  stored = new Map(); upserts = []; requests = []; reactions = []; sent = [];
}
const row = (messageId, over = {}) => ({
  chatId: String(CHAT), messageId, mediaGroupId: null, replyToMessageId: null, text: null, photos: [], editedAt: null, ...over,
});
const tag = (replied, over = {}) => ({
  message_id: 175,
  chat: { id: CHAT },
  from: { id: 4242, first_name: 'Ann', is_bot: false },
  date: 1794650700,
  text: '@wenze_recruit_bot',
  entities: [{ type: 'mention', offset: 0, length: 18 }],
  reply_to_message: { chat: { id: CHAT }, date: 1794640000, ...replied },
  ...over,
});
const note = (message, settings = SETTINGS) => noteBotRequest(message, settings, { botInfo: BOT, telegram });

test('A POST THE BOT NEVER SAW is rebuilt from reply_to_message — words, photo ids, album, author — and queued', async () => {
  reset();
  const thread = await note(tag({
    message_id: 169, from: KIM, caption: 'KWAME ASANTE\n(555) 201-3344', media_group_id: 'g9',
    photo: [{ file_id: 'small', width: 90, height: 60 }, { file_id: 'cdl', width: 1280, height: 853 }],
  }));
  assert.equal(upserts.length, 1);
  const rebuilt = upserts[0];
  assert.equal(rebuilt.messageId, 169);
  assert.equal(rebuilt.recoveredFromReply, true);
  assert.equal(rebuilt.botRequest, false);
  assert.equal(rebuilt.text, 'KWAME ASANTE\n(555) 201-3344');
  assert.deepEqual(rebuilt.photos.map((p) => p.file_id), ['cdl']);
  assert.equal(rebuilt.mediaGroupId, 'g9');
  assert.equal(rebuilt.fromUserId, 500);
  assert.equal(rebuilt.fromName, 'Kim');
  assert.equal(rebuilt.replyToMessageId, null, 'Telegram does not say what it replied to: it is taken as the post');

  assert.deepEqual(requests, [{
    chatId: String(CHAT), rootMessageId: 169, requestMessageId: 175, requestedByUserId: '4242', requestedByName: 'Ann', settleSeconds: 60,
  }]);
  assert.equal(REQUEST_SETTLE_SECONDS, 60, 'a minute, not the ten of a normal message');
  assert.equal(thread.id, 7);
  assert.deepEqual(reactions, ['175:👀']);
  assert.equal(sent.length, 0, 'nothing is written in General');
});

test('AN EDITED POST: Telegram\'s newer copy replaces the stored words; the same or an older copy changes nothing', async () => {
  reset();
  stored.set(169, row(169, { text: 'KWAME ASANTE', editedAt: new Date('2026-11-14T09:00:00Z') }));
  await note(tag({ message_id: 169, from: KIM, text: 'KWAME ASANTE\n(555) 201-3344', edit_date: 1794650400 }));
  assert.equal(upserts.length, 1);
  assert.equal(stored.get(169).text, 'KWAME ASANTE\n(555) 201-3344');

  await note(tag({ message_id: 169, from: KIM, text: 'KWAME ASANTE\n(555) 201-3344', edit_date: 1794650400 }));
  assert.equal(upserts.length, 1, 'already current');
  await note(tag({ message_id: 169, from: KIM, text: 'KWAME', edit_date: 1794643200 }));
  assert.equal(upserts.length, 1, 'an older copy never replaces a newer one');
  assert.equal(requests.length, 3);
});

test('a tag on a REPLY deep in the conversation queues the conversation\'s post', async () => {
  reset();
  stored.set(169, row(169, { mediaGroupId: 'g1', text: 'KWAME ASANTE' }));
  stored.set(170, row(170, { mediaGroupId: 'g1' }));
  stored.set(172, row(172, { replyToMessageId: 170, text: 'CLH sent' }));
  await note(tag({ message_id: 172, from: { id: 900, first_name: 'Safety', is_bot: false }, text: 'CLH sent' }));
  assert.equal(requests[0].rootMessageId, 169);
  assert.equal(stored.get(172).replyToMessageId, 170, 'a stored reply keeps what it replies to');
});

test('a tag the bot cannot place is answered 🤷 at once — on a bot\'s message, or on a chain to a post it never saw', async () => {
  reset();
  assert.equal(await note(tag({ message_id: 160, from: { id: 1, is_bot: true, username: 'some_bot' }, text: 'hello' })), null);
  stored.set(300, row(300, { replyToMessageId: 299, text: 'ok' }));
  assert.equal(await note(tag({ message_id: 300, from: KIM, text: 'ok' })), null);
  assert.equal(requests.length, 0);
  assert.deepEqual(reactions, ['175:🤷', '175:🤷']);
});

test('NOTHING AT ALL when it is not a request: switched off, not a reply, a bot, an edit', async () => {
  reset();
  const replied = { message_id: 169, from: KIM, text: 'KWAME ASANTE' };
  assert.equal(await note(tag(replied), { ...SETTINGS, stageProposalsEnabled: false }), null);
  assert.equal(await note(tag(replied), { ...SETTINGS, bitrixTopicId: null }), null);
  assert.equal(await note(tag(replied, { reply_to_message: undefined })), null);
  assert.equal(await note(tag(replied, { from: { id: 1087968824, is_bot: true, username: 'GroupAnonymousBot' } })), null);
  assert.equal(await note(tag(replied, { edit_date: 1794650800 })), null);
  assert.deepEqual([upserts.length, requests.length, reactions.length], [0, 0, 0]);
});

test('a reaction Telegram refuses never stops the request', async () => {
  reset();
  telegram.setMessageReaction = async () => { throw new Error('400: Bad Request: REACTION_INVALID'); };
  const thread = await note(tag({ message_id: 169, from: KIM, text: 'KWAME ASANTE' }));
  assert.equal(thread.rootMessageId, 169);
});
