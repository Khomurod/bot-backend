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

const POST = 'Company Driver - 80 CPM\n\nJohn <Bolling>\n3,5 yrs of exp\n+17049572114';

test('the caption: the recruiter\'s words as written, then the decision, who made it, and the link', () => {
  assert.equal(buildCaption({
    decision: 'not_approved', postText: POST, name: 'John Bolling', decidedBy: 'Aubrey Davis',
    reason: 'driver at fault & more', recruiterName: 'Amelia Carter', link: 'https://t.me/c/123/193',
  }), [
    'Company Driver - 80 CPM', '', 'John &lt;Bolling&gt;', '3,5 yrs of exp', '+17049572114',
    '━━━━━━━━━━━━━━━━━━',
    '❌ <b>NOT APPROVED</b> by Aubrey Davis',
    '📝 Reason: driver at fault &amp; more',
    '👤 Recruiter: Amelia Carter · 🔗 <a href="https://t.me/c/123/193">Original post</a>',
  ].join('\n'));
});

test('a team names whose decision it is; a name off the CDL says so; an SSN never shows', () => {
  assert.match(buildCaption({ decision: 'approved', postText: POST, name: 'Darnell Brooks', nameInStatus: true }),
    /✅ <b>APPROVED<\/b> — <b>Darnell Brooks<\/b>$/);
  assert.match(buildCaption({ decision: 'approved', postText: '', name: 'Joe Hardeman', nameFromCdl: true }),
    /^👤 <b>Joe Hardeman<\/b> <i>\(name read from the CDL\)<\/i>\n━/);
  assert.doesNotMatch(buildCaption({ decision: 'approved', postText: 'Joe\nssn; 455453402', name: 'Joe' }), /455453402/);
});

test('a long post gives way, and the caption fits Telegram\'s limit', () => {
  const caption = buildCaption({
    decision: 'approved', postText: '<&>'.repeat(900), name: 'R I', decidedBy: 'S', link: 'https://t.me/c/1/2',
  });
  assert.ok(caption.length <= CAPTION_LIMIT, String(caption.length));
  assert.match(caption, /…\n━/);
  assert.match(caption, /Original post<\/a>$/, 'the decision and the link survive; the post is what was cut');
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

test('a FORWARDED post remembers who it is really from', () => {
  const fwd = shapeCapturedMessage({
    message_id: 194, chat: { id: -1001 }, from: { id: 900, first_name: 'Aubrey' }, caption: 'John Bolling',
    forward_origin: { type: 'user', sender_user: { id: 777, first_name: 'Amelia', last_name: 'Carter | Driver Relations' } },
  });
  assert.equal(fwd.fromUserId, 900);
  assert.equal(fwd.forwardedFromUserId, 777);
  assert.equal(fwd.forwardedFromName, 'Amelia Carter | Driver Relations');
  const hidden = shapeCapturedMessage({
    message_id: 195, chat: { id: -1001 }, from: { id: 900 }, forward_origin: { type: 'hidden_user', sender_user_name: 'Amelia C' },
  });
  assert.deepEqual([hidden.forwardedFromUserId, hidden.forwardedFromName], [null, 'Amelia C']);
  const own = shapeCapturedMessage({ message_id: 196, chat: { id: -1001 }, from: { id: 900 }, text: 'hi' });
  assert.deepEqual([own.forwardedFromUserId, own.forwardedFromName], [null, null]);
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
