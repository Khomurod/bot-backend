'use strict';

/**
 * lib/safetyApprovals/announcement.js and messageShape.js — what the approvals
 * topic is told, where, and how a captured message is stored. Names are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCaption, parseTopicReference, postLink, CAPTION_LIMIT,
} = require('../lib/safetyApprovals/announcement');
const { shapeCapturedMessage, isImageDocument } = require('../lib/safetyApprovals/messageShape');

test('an approval caption: status, name, phone, Safety\'s own words, people, link', () => {
  const caption = buildCaption({
    decision: 'approved',
    name: 'Renata Ilves',
    phone: '(555) 010-7788',
    safetyNote: 'We can hire <Renata> & go',
    recruiterName: 'Kim | Recruitment',
    safetyName: 'A. Davis',
    link: 'https://t.me/c/123/45',
  });
  assert.equal(caption, [
    '✅ <b>APPROVED</b>',
    '<b>Renata Ilves</b>',
    '📞 (555) 010-7788',
    '💬 «We can hire &lt;Renata&gt; &amp; go»',
    '👤 Recruiter: Kim | Recruitment · Safety: A. Davis',
    '<a href="https://t.me/c/123/45">Original post</a>',
  ].join('\n'));
});

test('a refusal, with nothing optional', () => {
  assert.equal(buildCaption({ decision: 'not_approved', name: 'Renata Ilves' }),
    '❌ <b>NOT APPROVED</b>\n<b>Renata Ilves</b>');
});

test('a long note gives way, and the caption fits Telegram\'s limit', () => {
  const caption = buildCaption({
    decision: 'approved', name: 'Renata Ilves', phone: '555-010-7788', safetyNote: '<&>'.repeat(900),
    recruiterName: 'R', safetyName: 'S', link: 'https://t.me/c/1/2',
  });
  assert.ok(caption.length <= CAPTION_LIMIT, String(caption.length));
  assert.match(caption, /…»/);
  assert.match(caption, /Original post<\/a>$/, 'the link survives; the note is what was cut');
  assert.doesNotMatch(caption, /&(?!amp;|lt;|gt;|quot;)/, 'never cut through an escape');
});

test('the topic is read from a number or a t.me link', () => {
  assert.deepEqual(parseTopicReference('45'), { topicId: 45, chatId: null });
  assert.deepEqual(parseTopicReference('https://t.me/c/1234567890/45'), { topicId: 45, chatId: '-1001234567890' });
  assert.deepEqual(parseTopicReference('t.me/c/1234567890/45/678'), { topicId: 45, chatId: '-1001234567890' });
  for (const bad of ['', '0', '-5', 'general', 'https://t.me/somegroup/45']) {
    assert.ok(parseTopicReference(bad).error, bad);
  }
});

test('a link to the post exists only for a supergroup', () => {
  assert.equal(postLink('-1001234567890', 77), 'https://t.me/c/1234567890/77');
  assert.equal(postLink('-5052301861', 77), null);
});

test('a captured photo album item keeps the biggest photo, the caption and the reply', () => {
  const shaped = shapeCapturedMessage({
    message_id: 10,
    chat: { id: -1001 },
    from: { id: 7, first_name: 'Kim', last_name: 'R' },
    media_group_id: 'g1',
    date: 1760000000,
    caption: 'Renata Ilves 555-010-7788',
    photo: [
      { file_id: 'small', width: 90, height: 60 },
      { file_id: 'big', file_unique_id: 'u', width: 1280, height: 853, file_size: 99 },
      { file_id: 'mid', width: 320, height: 213 },
    ],
    reply_to_message: { message_id: 4 },
  });
  assert.deepEqual(shaped.photos, [{ file_id: 'big', file_unique_id: 'u', width: 1280, height: 853, file_size: 99 }]);
  assert.equal(shaped.text, 'Renata Ilves 555-010-7788');
  assert.equal(shaped.fromName, 'Kim R');
  assert.equal(shaped.replyToMessageId, 4);
  assert.equal(shaped.mediaGroupId, 'g1');
  assert.equal(shaped.chatId, '-1001');
});

test('a message in a forum topic is not a reply to the topic', () => {
  const inTopic = shapeCapturedMessage({
    message_id: 20, chat: { id: -1001 }, from: { id: 9 }, text: 'approved',
    is_topic_message: true, message_thread_id: 3,
    reply_to_message: { message_id: 3, forum_topic_created: { name: 'Drivers' } },
  });
  assert.equal(inTopic.replyToMessageId, null);
  const realReply = shapeCapturedMessage({
    message_id: 21, chat: { id: -1001 }, from: { id: 9 }, text: 'approved',
    is_topic_message: true, message_thread_id: 3, reply_to_message: { message_id: 15 },
  });
  assert.equal(realReply.replyToMessageId, 15);
});

test('a document keeps its name; blank text is no text; non-messages are null', () => {
  const doc = shapeCapturedMessage({
    message_id: 30, chat: { id: -1001 }, from: { id: 9, is_bot: false }, caption: '   ',
    document: { file_id: 'd1', file_name: 'R ILVES PSP.pdf', mime_type: 'application/pdf' },
  });
  assert.equal(doc.text, null);
  assert.equal(doc.documents[0].file_name, 'R ILVES PSP.pdf');
  assert.equal(isImageDocument(doc.documents[0]), false);
  assert.equal(isImageDocument({ mime_type: 'image/jpeg' }), true);
  assert.equal(shapeCapturedMessage(null), null);
  assert.equal(shapeCapturedMessage({ chat: { id: 1 } }), null);
});
