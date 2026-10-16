'use strict';

/**
 * services/safetyApprovals/reviewer.js — from a queued Safety reply to what is
 * posted in the approvals topic. The model is faked; its answer still goes
 * through the real lib/safetyApprovals/reading.js, so every guard is live.
 * Names, numbers and file ids are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
function stub(rel, exports) {
  const filename = require.resolve(path.resolve(ROOT, rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ── an in-memory group ────────────────────────────────────────────────────
let rows = [];
let announcements = [];
const finished = [];
const retried = [];

stub('database/safetyApprovals/messages.js', {
  getMessage: async (chatId, id) => rows.find((r) => r.chatId === chatId && r.messageId === id) || null,
  getMediaGroup: async (chatId, mg) => rows.filter((r) => r.chatId === chatId && r.mediaGroupId === mg),
  listSenderMessagesAround: async ({ chatId, fromUserId }) => rows.filter((r) => r.chatId === chatId
    && r.fromUserId === fromUserId && !r.replyToMessageId),
  listSafetyReplies: async ({ chatId, postMessageIds, safetyUserIds }) => {
    const direct = rows.filter((r) => r.chatId === chatId && postMessageIds.includes(r.replyToMessageId)
      && safetyUserIds.includes(r.fromUserId));
    const groups = new Set(direct.map((r) => r.mediaGroupId).filter(Boolean));
    return rows.filter((r) => direct.includes(r) || (r.mediaGroupId && groups.has(r.mediaGroupId)));
  },
});
stub('database/safetyApprovals/reviews.js', {
  finishReview: async (review, fields) => { finished.push({ id: review.id, ...fields }); return true; },
  retryReview: async (review, fields) => { retried.push({ id: review.id, ...fields }); return true; },
  lastAnnouncement: async (chatId, postId, key) => announcements
    .filter((a) => a.chatId === chatId && a.postMessageId === postId && a.driverKey === key).at(-1) || null,
  recordAnnouncement: async (a) => { announcements.push(a); },
});

const { processReview } = require('../services/safetyApprovals/reviewer');
const { readSafetyReply, AiUnavailableError } = require('../services/safetyApprovals/aiReading');

const CHAT = '-1001234567890';
const SAFETY = '900';
const RECRUITER = '500';
const NOW = Date.parse('2026-10-16T15:00:00Z');
const AGO = (s) => new Date(NOW - s * 1000);
const SETTINGS = { enabled: true, chatId: CHAT, topicId: 45, safetyUserIds: [SAFETY] };

function msg(fields) {
  return {
    chatId: CHAT, threadId: null, mediaGroupId: null, fromName: null, text: null,
    photos: [], documents: [], replyToMessageId: null, sentAt: AGO(600), editedAt: null, ...fields,
  };
}
const photo = (id) => [{ file_id: id, file_size: 1000 }];
const pdf = (id, name) => [{ file_id: id, file_unique_id: `u-${id}`, file_name: name, mime_type: 'application/pdf' }];

function soloPost() {
  return [
    msg({ messageId: 10, fromUserId: RECRUITER, fromName: 'Kim R', mediaGroupId: 'p1', photos: photo('cdl-front'),
      text: 'Solo company driver\nRenata Ilves\n555-010-7788\nexp 3 years' }),
    msg({ messageId: 11, fromUserId: RECRUITER, fromName: 'Kim R', mediaGroupId: 'p1', photos: photo('cdl-back') }),
  ];
}
function safetyAlbum(text, { replyTo = 11, at = 300 } = {}) {
  return [
    msg({ messageId: 20, fromUserId: SAFETY, fromName: 'A. Davis', mediaGroupId: 's1', replyToMessageId: replyTo,
      documents: pdf('psp', 'R ILVES PSP.pdf'), sentAt: AGO(at) }),
    msg({ messageId: 21, fromUserId: SAFETY, fromName: 'A. Davis', mediaGroupId: 's1',
      documents: pdf('mvr', 'R ILVES MVR.pdf'), text, sentAt: AGO(at) }),
  ];
}

function fakeTelegram() {
  const calls = [];
  return {
    calls,
    sendMediaGroup: async (chatId, media, extra) => {
      calls.push({ kind: 'album', chatId, media, extra });
      return media.map((_, i) => ({ message_id: 700 + i }));
    },
    sendDocument: async (chatId, doc, extra) => { calls.push({ kind: 'doc', chatId, doc, extra }); return { message_id: 690 }; },
    sendMessage: async (chatId, text, extra) => { calls.push({ kind: 'text', chatId, text, extra }); return { message_id: 680 }; },
  };
}

/** A model that answers `answer`, through the real verifier. */
function model(answer) {
  return (args) => readSafetyReply(args, {
    runCapability: async () => ({ parsed: answer, provider: 'fake', model: 'fake-1' }),
    prepareImagePart: async (buffer, mime) => ({ inline_data: { mime_type: mime, data: buffer.toString('base64') } }),
  });
}

function deps(extra = {}) {
  return {
    settings: SETTINGS,
    telegram: fakeTelegram(),
    download: async (fileId) => Buffer.from(`bytes:${fileId}`),
    now: () => NOW,
    ...extra,
  };
}

const review = (fields = {}) => ({
  id: 1, chatId: CHAT, postMessageId: 11, attempts: 1, revision: 0, createdAt: AGO(300), ...fields,
});

function reset(seed) {
  rows = seed;
  announcements = [];
  finished.length = 0;
  retried.length = 0;
}

const APPROVED_RENATA = {
  candidates: [{ name: 'Renata Ilves', phone: '555 010 7788', cdl_photo: 0 }],
  decisions: [{ name: 'Renata Ilves', decision: 'approved' }],
};

test('one block of files in the topic: the CDL as a file, Safety\'s PDFs, the status under them', async () => {
  reset([...soloPost(), ...safetyAlbum('We cah hire renata')]);
  const d = deps({ readReply: model(APPROVED_RENATA) });
  assert.equal(await processReview(review(), d), 'published');

  assert.equal(d.telegram.calls.length, 1);
  const [call] = d.telegram.calls;
  assert.equal(call.kind, 'album');
  assert.equal(call.chatId, CHAT);
  assert.deepEqual(call.extra, { message_thread_id: 45 });
  assert.equal(call.media.length, 3);
  assert.ok(call.media.every((m) => m.type === 'document'));
  assert.deepEqual(call.media[0].media.source, Buffer.from('bytes:cdl-front'));
  assert.equal(call.media[0].media.filename, 'CDL - Renata Ilves.jpg');
  assert.deepEqual(call.media.slice(1).map((m) => m.media), ['psp', 'mvr']);
  const { caption } = call.media[2];
  assert.match(caption, /✅ <b>APPROVED<\/b>/);
  assert.match(caption, /<b>Renata Ilves<\/b>/);
  assert.match(caption, /📞 555-010-7788/, 'the phone as the recruiter typed it');
  assert.match(caption, /«We cah hire renata»/, 'Safety\'s words, verbatim');
  assert.match(caption, /https:\/\/t\.me\/c\/1234567890\/10/, 'a link to the post\'s first message');
  assert.equal(call.media[0].caption, undefined, 'the caption sits under the block');

  assert.equal(announcements.length, 1);
  assert.equal(announcements[0].postMessageId, 10);
  assert.deepEqual(announcements[0].topicMessageIds, [700, 701, 702]);
  assert.equal(finished.at(-1).status, 'published');
});

test('the same decision is not posted twice; a reversed one is', async () => {
  reset([...soloPost(), ...safetyAlbum('We can hire Renata')]);
  await processReview(review(), deps({ readReply: model(APPROVED_RENATA) }));
  const again = deps({ readReply: model(APPROVED_RENATA) });
  assert.equal(await processReview(review({ id: 2 }), again), 'published');
  assert.equal(again.telegram.calls.length, 0);
  assert.deepEqual(finished.at(-1).outcome.unchanged, ['Renata Ilves']);

  rows = [...soloPost(), ...safetyAlbum('Sorry, cannot hire Renata, 3 accidents')];
  const reversed = deps({
    readReply: model({ ...APPROVED_RENATA, decisions: [{ name: 'Renata Ilves', decision: 'not_approved' }] }),
  });
  await processReview(review({ id: 3 }), reversed);
  assert.equal(reversed.telegram.calls.length, 1);
  assert.match(reversed.telegram.calls[0].media.at(-1).caption, /❌ <b>NOT APPROVED<\/b>/);
});

test('an "approved" next to refusal words, or an unclear reply, posts nothing', async () => {
  const unclear = { ...APPROVED_RENATA, decisions: [{ name: 'Renata Ilves', decision: 'unclear' }] };
  for (const [text, answer] of [
    ["We can't hire her", APPROVED_RENATA],
    ['Can we hire her?', APPROVED_RENATA],
    ['let me check her clearinghouse first', unclear],
  ]) {
    reset([...soloPost(), ...safetyAlbum(text)]);
    const d = deps({ readReply: model(answer) });
    assert.equal(await processReview(review(), d), 'unclear', text);
    assert.equal(d.telegram.calls.length, 0, text);
  }
});

test('a fresh reply with no words yet is given time, without spending an attempt', async () => {
  reset([...soloPost(), ...safetyAlbum(null, { at: 20 })]);
  const d = deps({ readReply: () => assert.fail('must not read yet') });
  assert.equal(await processReview(review(), d), 'waiting');
  assert.equal(retried[0].countAttempt, false);
  assert.ok(retried[0].delaySeconds >= 100 && retried[0].delaySeconds <= 110, String(retried[0].delaySeconds));

  reset([...soloPost(), ...safetyAlbum(null, { at: 600 })]);
  assert.equal(await processReview(review(), deps()), 'unclear', 'an old reply with no words is no decision');
});

test('a reply to a message the bot never saw, or with the feature off, posts nothing', async () => {
  reset(safetyAlbum('approved'));
  assert.equal(await processReview(review(), deps({ readReply: model(APPROVED_RENATA) })), 'no_post');
  assert.equal(finished.at(-1).outcome.reason, 'post_not_seen');

  reset([...soloPost(), ...safetyAlbum('approved')]);
  const off = deps({ settings: { ...SETTINGS, enabled: false } });
  assert.equal(await processReview(review(), off), 'no_post');
  assert.equal(off.telegram.calls.length, 0);
});

test('no model: wait and try again, then give up after six attempts', async () => {
  reset([...soloPost(), ...safetyAlbum('approved')]);
  const down = deps({ readReply: async () => { throw new AiUnavailableError('no provider'); } });
  assert.equal(await processReview(review({ attempts: 2 }), down), 'retry');
  assert.equal(retried.at(-1).delaySeconds, 300);
  assert.equal(await processReview(review({ attempts: 6 }), down), 'gave_up');
  assert.equal(finished.at(-1).status, 'gave_up');
  assert.equal(down.telegram.calls.length, 0);
});

test('a team: only the driver Safety named is posted, with only that driver\'s files', async () => {
  reset([
    msg({ messageId: 30, fromUserId: RECRUITER, mediaGroupId: 't1', photos: photo('cdl-calvin') }),
    msg({ messageId: 31, fromUserId: RECRUITER, mediaGroupId: 't1', photos: photo('cdl-darnell') }),
    msg({ messageId: 32, fromUserId: RECRUITER, text: 'Company team drivers 95 CPM\nDarnell Brooks (main)\n'
      + '(555) 010-2233\nCalvin Brooks\n(555) 010-4455\nready:' }),
    msg({ messageId: 40, fromUserId: SAFETY, mediaGroupId: 's2', replyToMessageId: 30,
      documents: pdf('d-psp', 'DARNELL BROOKS PSP.pdf') }),
    msg({ messageId: 41, fromUserId: SAFETY, mediaGroupId: 's2', documents: pdf('c-mvr', 'CALVIN BROOKS MVR.pdf') }),
    msg({ messageId: 42, fromUserId: SAFETY, mediaGroupId: 's2', documents: pdf('clh', 'CLH.pdf'),
      text: 'We cah hire darnell brooks' }),
  ]);
  const d = deps({
    readReply: model({
      candidates: [
        { name: 'Darnell Brooks', phone: '5550102233', cdl_photo: 1 },
        { name: 'Calvin Brooks', phone: '5550104455', cdl_photo: 0 },
      ],
      decisions: [
        { name: 'Darnell Brooks', decision: 'approved' },
        { name: 'Calvin Brooks', decision: 'approved' },
      ],
    }),
  });
  assert.equal(await processReview(review({ postMessageId: 30 }), d), 'published');
  assert.equal(d.telegram.calls.length, 1, 'Calvin was not named, so Calvin is not posted');
  const { media } = d.telegram.calls[0];
  assert.deepEqual(media[0].media.source, Buffer.from('bytes:cdl-darnell'));
  assert.deepEqual(media.slice(1).map((m) => m.media), ['d-psp', 'clh'], 'not Calvin\'s MVR');
  assert.match(media.at(-1).caption, /📞 \(555\) 010-2233/);
});

test('nothing to attach is a plain message in the topic', async () => {
  reset([
    msg({ messageId: 10, fromUserId: RECRUITER, text: 'Renata Ilves 555-010-7788' }),
    msg({ messageId: 20, fromUserId: SAFETY, replyToMessageId: 10, text: 'Renata not approved', sentAt: AGO(600) }),
  ]);
  const d = deps({
    readReply: model({ candidates: [{ name: 'Renata Ilves' }], decisions: [{ name: 'Renata Ilves', decision: 'not_approved' }] }),
  });
  assert.equal(await processReview(review({ postMessageId: 10 }), d), 'published');
  assert.equal(d.telegram.calls[0].kind, 'text');
  assert.equal(d.telegram.calls[0].extra.message_thread_id, 45);
});

test('no vision model for a while: the words are read, and the post goes out without the CDL', async () => {
  reset([...soloPost(), ...safetyAlbum('We can hire Renata')]);
  const calls = [];
  const readReply = (args) => readSafetyReply(args, {
    runCapability: async (request) => {
      calls.push(Boolean(request.extraParts));
      if (request.extraParts) throw new AiUnavailableError('no vision provider');
      return { parsed: { ...APPROVED_RENATA, candidates: [{ name: 'Renata Ilves', phone: '5550107788', cdl_photo: 0 }] } };
    },
    prepareImagePart: async () => ({ inline_data: { mime_type: 'image/jpeg', data: '' } }),
  });

  assert.equal(await processReview(review({ attempts: 1 }), deps({ readReply })), 'retry', 'first, wait for one');
  assert.deepEqual(calls, [true]);

  const d = deps({ readReply });
  assert.equal(await processReview(review({ attempts: 3 }), d), 'published');
  assert.deepEqual(calls, [true, true, false]);
  const { media } = d.telegram.calls[0];
  assert.deepEqual(media.map((m) => m.media), ['psp', 'mvr'], 'no CDL: the model never saw a photo');
  assert.equal(finished.at(-1).outcome.withoutPhotos, true);
});
