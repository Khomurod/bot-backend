'use strict';

/**
 * services/safetyApprovals/reviewer.js — a Safety decision WITHOUT a hashtag
 * ("We can hire Renata, approved"), read by a model whose answer still goes
 * through the real lib/safetyApprovals/reading.js, posted as the driver's
 * post with the decision under it. The hashtag path is tests/safetyApprovalHashtag.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const fx = require('./helpers/safetyApprovalFixture');

const {
  state, processReview, readSafetyReply, AiUnavailableError, SAFETY, RECRUITER,
  msg, photo, pdf, soloPost, safetyAlbum, model, deps, review, reset,
} = fx;

const APPROVED_RENATA = {
  candidates: [{ name: 'Renata Ilves', phone: '555 010 7788', cdl_photo: 0 }],
  decisions: [{ name: 'Renata Ilves', decision: 'approved' }],
};

test('the driver\'s post as the recruiter sent it — photos by file id, words, then the decision and who', async () => {
  reset([...soloPost(), ...safetyAlbum('We cah hire renata, approved')]);
  const d = deps({ readReply: model(APPROVED_RENATA) });
  assert.equal(await processReview(review(), d), 'published');

  assert.equal(d.telegram.calls.length, 1, 'one album; Safety\'s PDFs are not re-posted');
  const [album] = d.telegram.calls;
  assert.equal(album.kind, 'album');
  assert.deepEqual(album.extra, { message_thread_id: 45 });
  assert.deepEqual(album.media.map((m) => [m.type, m.media]), [['photo', 'cdl-front'], ['photo', 'cdl-back']]);
  const { caption } = album.media[0];
  assert.equal(caption, [
    'Company Driver - 80 CPM',
    'Renata Ilves',
    '555-010-7788',
    'exp 3 years',
    '━━━━━━━━━━━━━━━━━━',
    '✅ <b>APPROVED</b> by A. Davis',
    '👤 Recruiter: Kim R · 🔗 <a href="https://t.me/c/1234567890/10">Original post</a>',
  ].join('\n'));
  assert.equal(album.media[1].caption, undefined, 'one caption, under the album');

  assert.equal(state.announcements[0].postMessageId, 10);
  assert.deepEqual(state.announcements[0].topicMessageIds, [681, 682]);
  assert.equal(state.finished.at(-1).outcome.mode, 'model');
});

test('the same decision is not posted twice; a reversed one is, with Safety\'s reason', async () => {
  reset([...soloPost(), ...safetyAlbum('We can hire Renata, approved')]);
  await processReview(review(), deps({ readReply: model(APPROVED_RENATA) }));
  const again = deps({ readReply: model(APPROVED_RENATA) });
  assert.equal(await processReview(review({ id: 2 }), again), 'published');
  assert.equal(again.telegram.calls.length, 0);
  assert.deepEqual(state.finished.at(-1).outcome.unchanged, ['Renata Ilves']);

  state.rows = [...soloPost(), ...safetyAlbum('3 accidents, not approved')];
  const reversed = deps({
    readReply: model({ ...APPROVED_RENATA, decisions: [{ name: 'Renata Ilves', decision: 'not_approved' }] }),
  });
  await processReview(review({ id: 3 }), reversed);
  assert.match(reversed.telegram.calls[0].media[0].caption, /❌ <b>NOT APPROVED<\/b> by A\. Davis\n📝 Reason: 3 accidents/);
});

test('WORDS THE MODEL CANNOT SETTLE: Safety is asked in General, under their own message', async () => {
  reset([...soloPost(), ...safetyAlbum("approved, but we can't hire her yet")]);
  const d = deps({ readReply: model(APPROVED_RENATA) });
  assert.equal(await processReview(review(), d), 'unclear');
  assert.equal(d.telegram.calls.length, 1);
  const [asked] = d.telegram.calls;
  assert.match(asked.text, /could not tell which driver, or what was decided/);
  assert.equal(asked.extra.reply_to_message_id, 21);
  assert.equal(asked.extra.message_thread_id, undefined, 'General, not the approvals topic');
  assert.equal(state.finished.at(-1).outcome.asked, true);
});

test('a QUESTION is not a decision: nothing posted, nobody asked, no model', async () => {
  reset([...soloPost(), ...safetyAlbum('is she approved?')]);
  const d = deps();
  assert.equal(await processReview(review(), d), 'unclear');
  assert.equal(d.telegram.calls.length, 0);
  assert.equal(state.finished.at(-1).outcome.reason, 'question');
});

test('a reply to a post the bot never saw: Safety is asked; feature off: nothing at all', async () => {
  reset(safetyAlbum('approved'));
  const d = deps();
  assert.equal(await processReview(review(), d), 'unclear');
  assert.match(d.telegram.calls[0].text, /could not find the driver's post this answers/);

  reset([...soloPost(), ...safetyAlbum('approved')]);
  const off = deps({ settings: { ...fx.SETTINGS, enabled: false } });
  assert.equal(await processReview(review(), off), 'no_post');
  assert.equal(off.telegram.calls.length, 0);
});

test('no model: wait and try again, then give up after six attempts', async () => {
  reset([...soloPost(), ...safetyAlbum('approved')]);
  const down = deps({ readReply: async () => { throw new AiUnavailableError('no provider'); } });
  assert.equal(await processReview(review({ attempts: 2 }), down), 'retry');
  assert.equal(state.retried.at(-1).delaySeconds, 300);
  assert.equal(await processReview(review({ attempts: 6 }), down), 'gave_up');
  assert.equal(down.telegram.calls.length, 0);
});

test('a team: only the driver Safety named is posted, and the status names him', async () => {
  reset([
    msg({ messageId: 30, fromUserId: RECRUITER, mediaGroupId: 't1', photos: photo('cdl-calvin') }),
    msg({ messageId: 31, fromUserId: RECRUITER, mediaGroupId: 't1', photos: photo('cdl-darnell') }),
    msg({ messageId: 32, fromUserId: RECRUITER, text: 'Company team drivers 95 CPM\nDarnell Brooks (main)\n'
      + '(555) 010-2233\nCalvin Brooks\n(555) 010-4455\nready:' }),
    msg({ messageId: 40, fromUserId: SAFETY, mediaGroupId: 's1', replyToMessageId: 30,
      documents: pdf('d-psp', 'DARNELL BROOKS PSP.pdf') }),
    msg({ messageId: 41, fromUserId: SAFETY, mediaGroupId: 's1', documents: pdf('c-mvr', 'CALVIN BROOKS MVR.pdf') }),
    msg({ messageId: 42, fromUserId: SAFETY, mediaGroupId: 's1', documents: pdf('clh', 'CLH.pdf'),
      text: 'darnell brooks approved' }),
  ]);
  const d = deps({
    readReply: model({
      candidates: [
        { name: 'Darnell Brooks', phone: '5550102233', cdl_photo: 1 },
        { name: 'Calvin Brooks', phone: '5550104455', cdl_photo: 0 },
      ],
      decisions: [{ name: 'Darnell Brooks', decision: 'approved' }, { name: 'Calvin Brooks', decision: 'approved' }],
    }),
  });
  assert.equal(await processReview(review({ postMessageId: 30 }), d), 'published');
  assert.equal(d.telegram.calls.length, 1, 'Calvin was not named, so Calvin is not posted');
  assert.match(d.telegram.calls[0].media[0].caption, /✅ <b>APPROVED<\/b> — <b>Darnell Brooks<\/b>\n/,
    'a team post says whose decision it is');
});

test('no vision model for a while: the words are read, and the decision still goes out', async () => {
  reset([...soloPost(), ...safetyAlbum('We can hire Renata, approved')]);
  const calls = [];
  const readReply = (args) => readSafetyReply(args, {
    runCapability: async (request) => {
      calls.push(Boolean(request.extraParts));
      if (request.extraParts) throw new AiUnavailableError('no vision provider');
      return { parsed: { ...APPROVED_RENATA, candidates: [{ name: 'Renata Ilves', phone: '5550107788', cdl_photo: 0 }] } };
    },
    prepareImagePart: async () => ({ inline_data: { mime_type: 'image/jpeg', data: '' } }),
  });
  assert.equal(await processReview(review({ attempts: 1 }), deps({ readReply })), 'retry');
  const d = deps({ readReply });
  assert.equal(await processReview(review({ attempts: 3 }), d), 'published');
  assert.deepEqual(calls, [true, true, false]);
  assert.match(d.telegram.calls[0].media[0].caption, /APPROVED/);
});

test('posted but not recorded: the retry does not post it again', async () => {
  reset([...soloPost(), ...safetyAlbum('We can hire Renata, approved')]);
  state.failComplete = true;
  assert.equal(await processReview(review(), deps({ readReply: model(APPROVED_RENATA) })), 'published');
  const retry = deps({ readReply: model(APPROVED_RENATA) });
  assert.equal(await processReview(review({ id: 2 }), retry), 'published');
  assert.equal(retry.telegram.calls.length, 0, 'the reservation says it went out');
});

test('Telegram refused: the reservation is given back, and the retry posts it', async () => {
  reset([...soloPost(), ...safetyAlbum('We can hire Renata, approved')]);
  const refusing = deps({ readReply: model(APPROVED_RENATA) });
  refusing.telegram.sendMediaGroup = async () => { throw new Error('400: Bad Request: message thread not found'); };
  assert.equal(await processReview(review(), refusing), 'retry');
  assert.equal(state.announcements.length, 0);
  const later = deps({ readReply: model(APPROVED_RENATA) });
  assert.equal(await processReview(review({ id: 2 }), later), 'published');
});
