'use strict';

/**
 * services/safetyApprovals/reviewer.js — the team's #Approved / #NotApproved
 * convention (owner, 20 October 2026). Pinned: a hashtag decides WITHOUT a
 * model and WITHOUT downloading anything; the topic gets the driver's post as
 * the recruiter sent it with "APPROVED by <Safety>" under it; a post Safety
 * forwarded is the recruiter's; a team hashtag that names nobody is asked
 * about, never guessed; a decision written on its own finds its post from the
 * messages before it, and when it cannot, Safety is asked.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const fx = require('./helpers/safetyApprovalFixture');

const {
  state, processReview, SAFETY, RECRUITER, AGO, msg, photo, pdf, soloPost, model, deps, review, reset,
} = fx;

/** One Safety message (not an album) carrying the words. */
const say = (messageId, text, fields = {}) => msg({
  messageId, fromUserId: SAFETY, fromName: 'Aubrey Davis', text, sentAt: AGO(300), ...fields,
});
const noDownload = { download: async () => { throw new Error('nothing may be downloaded'); } };
const captionOf = (call) => call.media?.[0]?.caption ?? call.extra?.caption ?? call.text;

test('#Approved under a post: NO MODEL, NO DOWNLOAD — the post\'s photos, its words, "APPROVED by Aubrey Davis"', async () => {
  reset([...soloPost(), say(21, '#Approved', { replyToMessageId: 10 })]);
  const d = deps(noDownload);
  assert.equal(await processReview(review({ safetyKey: 'message:21', postMessageId: 10 }), d), 'published');
  assert.equal(d.telegram.calls.length, 1);
  const [album] = d.telegram.calls;
  assert.deepEqual(album.media.map((m) => m.media), ['cdl-front', 'cdl-back']);
  assert.match(captionOf(album), /^Company Driver - 80 CPM\nRenata Ilves\n555-010-7788\nexp 3 years\n━+\n✅ <b>APPROVED<\/b> by Aubrey Davis\n/);
  assert.doesNotMatch(captionOf(album), /📝/, 'nothing but the hashtag: no reason line');
  assert.equal(state.finished.at(-1).outcome.mode, 'hashtag');
});

test('#NotApproved with words: the words are the reason; a later #Approved is posted as a change', async () => {
  reset([...soloPost(), say(21, '#NotApproved driver at fault', { replyToMessageId: 11 })]);
  const d = deps(noDownload);
  await processReview(review({ safetyKey: 'message:21' }), d);
  assert.match(captionOf(d.telegram.calls[0]), /❌ <b>NOT APPROVED<\/b> by Aubrey Davis\n📝 Reason: driver at fault/);

  state.rows = [...soloPost(), say(21, '#approved', { replyToMessageId: 11 })];
  const changed = deps(noDownload);
  await processReview(review({ id: 2, safetyKey: 'message:21' }), changed);
  assert.match(captionOf(changed.telegram.calls[0]), /✅ <b>APPROVED<\/b>/);
});

test('A POST SAFETY FORWARDED is the recruiter\'s — the John Bolling case of 20 October', async () => {
  const fwd = { forwardedFromUserId: '777', forwardedFromName: 'Amelia Carter | Driver Relations' };
  reset([
    // Safety's own PDF album just before, with words of its own: not part of the post.
    msg({ messageId: 189, fromUserId: SAFETY, mediaGroupId: 'own', documents: pdf('psp', 'PSP.pdf'), sentAt: AGO(900) }),
    msg({ messageId: 192, fromUserId: SAFETY, mediaGroupId: 'own', text: 'Looks good, we can hire him', sentAt: AGO(900) }),
    msg({ messageId: 193, fromUserId: SAFETY, mediaGroupId: 'fw', photos: photo('medical'), sentAt: AGO(890), ...fwd }),
    msg({ messageId: 194, fromUserId: SAFETY, mediaGroupId: 'fw', photos: photo('cdl'), sentAt: AGO(890), ...fwd,
      text: 'Company Driver - 80 CPM\n\nJohn Bolling\n3,5 yrs of exp\n+17049572114' }),
    msg({ messageId: 195, fromUserId: SAFETY, photos: photo('old-cdl'), text: 'old cdl', sentAt: AGO(889), ...fwd }),
    say(198, '#Approved', { replyToMessageId: 195 }),
    say(199, '#Approved', { replyToMessageId: 193 }),
  ]);
  const d = deps(noDownload);
  assert.equal(await processReview(review({ safetyKey: 'message:199', postMessageId: 193 }), d), 'published');
  const caption = captionOf(d.telegram.calls[0]);
  assert.match(caption, /John Bolling[\s\S]*✅ <b>APPROVED<\/b> by Aubrey Davis[\s\S]*👤 Recruiter: Amelia Carter ·/);
  assert.doesNotMatch(caption, /Looks good/, 'Safety\'s own words are not the post');

  const again = deps(noDownload);
  assert.equal(await processReview(review({ id: 2, safetyKey: 'message:198', postMessageId: 195 }), again), 'published');
  assert.equal(again.telegram.calls.length, 0, '"old cdl" is the same post\'s piece: John is already posted');
});

const TEAM = () => [
  msg({ messageId: 30, fromUserId: RECRUITER, text: 'Company team drivers 95 CPM\nDarnell Brooks (main)\n'
    + '(555) 010-2233\nCalvin Brooks\n(555) 010-4455', photos: photo('cdl-d') }),
];

test('A TEAM: a hashtag that names nobody is ASKED about, never guessed', async () => {
  reset([...TEAM(), say(40, '#Approved', { replyToMessageId: 30 })]);
  const d = deps(noDownload);
  assert.equal(await processReview(review({ safetyKey: 'message:40', postMessageId: 30 }), d), 'unclear');
  assert.equal(d.telegram.calls.length, 1);
  assert.match(d.telegram.calls[0].text, /more than one driver[\s\S]*#Approved Darnell/);
  assert.equal(d.telegram.calls[0].extra.reply_to_message_id, 40);
  assert.equal(state.announcements.length, 0);
});

test('a team, each named: one post per driver, the status naming whose it is, with the reason', async () => {
  reset([...TEAM(), say(40, '#Approved Darnell #NotApproved Calvin 3 accidents', { replyToMessageId: 30 })]);
  const d = deps(noDownload);
  assert.equal(await processReview(review({ safetyKey: 'message:40', postMessageId: 30 }), d), 'published');
  assert.deepEqual(d.telegram.calls.map((c) => c.kind), ['photo', 'photo']);
  assert.match(captionOf(d.telegram.calls[0]), /✅ <b>APPROVED<\/b> — <b>Darnell Brooks<\/b> by Aubrey Davis/);
  assert.match(captionOf(d.telegram.calls[1]), /❌ <b>NOT APPROVED<\/b> — <b>Calvin Brooks<\/b> by Aubrey Davis\n📝 Reason: 3 accidents/);
});

test('a post with no name in writing: the model is asked for the NAME only — the hashtag still decides', async () => {
  reset([
    msg({ messageId: 10, fromUserId: RECRUITER, text: 'Joe Hardeman wanna come back asap', photos: photo('cdl') }),
    say(21, '#NotApproved', { replyToMessageId: 10 }),
  ]);
  const d = deps({
    readReply: model({
      candidates: [{ name: 'Joe Hardeman', cdl_photo: 0 }],
      decisions: [{ name: 'Joe Hardeman', decision: 'approved' }],
    }),
  });
  assert.equal(await processReview(review({ safetyKey: 'message:21', postMessageId: 10 }), d), 'published');
  assert.match(captionOf(d.telegram.calls[0]), /❌ <b>NOT APPROVED<\/b>/, 'the model\'s "approved" is ignored');
  assert.equal(state.finished.at(-1).outcome.mode, 'hashtag_model_names');
});

test('both hashtags for one driver: Safety is asked which', async () => {
  reset([...soloPost(), say(21, '#Approved #NotApproved', { replyToMessageId: 10 })]);
  const d = deps(noDownload);
  assert.equal(await processReview(review({ safetyKey: 'message:21', postMessageId: 10 }), d), 'unclear');
  assert.match(d.telegram.calls[0].text, /carries both hashtags/);
});

test('a reply to the recruiter\'s follow-up ("schedule his drug test?") is about the POST it follows', async () => {
  reset([
    ...soloPost(),
    msg({ messageId: 15, fromUserId: RECRUITER, replyToMessageId: 10, text: 'could we schedule his drug test\nssn; 455453402' }),
    say(21, '#Approved', { replyToMessageId: 15 }),
  ]);
  const d = deps(noDownload);
  assert.equal(await processReview(review({ safetyKey: 'message:21', postMessageId: 15 }), d), 'published');
  assert.match(captionOf(d.telegram.calls[0]), /Renata Ilves/);
  assert.doesNotMatch(captionOf(d.telegram.calls[0]), /455453402/);
  assert.equal(state.announcements[0].postMessageId, 10);
});

// ── a decision written on its own, not as a reply ─────────────────────────

test('NOT A REPLY, one post being discussed just before: that post, with no model', async () => {
  reset([
    ...soloPost(),
    msg({ messageId: 12, fromUserId: SAFETY, replyToMessageId: 10, text: 'CLH sent', documents: pdf('clh', 'CLH.pdf') }),
    msg({ messageId: 13, fromUserId: RECRUITER, replyToMessageId: 12, text: 'Done' }),
    say(21, '#NotApproved driver was at fault'),
  ]);
  const d = deps(noDownload);
  assert.equal(await processReview(review({ safetyKey: 'message:21', postMessageId: null }), d), 'published');
  assert.match(captionOf(d.telegram.calls[0]), /Renata Ilves[\s\S]*NOT APPROVED[\s\S]*Reason: driver was at fault/);
  assert.equal(state.announcements[0].postMessageId, 10);
  assert.equal(state.finished.at(-1).outcome.located, 'only_post_nearby');
});

test('not a reply, two posts in play: the model PICKS one by label — or Safety is asked', async () => {
  const seed = () => [
    ...soloPost(),
    msg({ messageId: 50, fromUserId: RECRUITER, text: 'Company driver 80 CPM\nEddie Watson\n(404) 555-0134', photos: photo('cdl-e') }),
    msg({ messageId: 51, fromUserId: SAFETY, replyToMessageId: 50, text: 'CLH sent' }),
    msg({ messageId: 52, fromUserId: SAFETY, replyToMessageId: 10, text: 'MVR clean' }),
    say(60, '#Approved'),
  ];
  reset(seed());
  const picked = [];
  const d = deps({ ...noDownload, pickPost: async ({ posts }) => { picked.push(posts.map((p) => p.anchorId)); return 1; } });
  assert.equal(await processReview(review({ safetyKey: 'message:60', postMessageId: null }), d), 'published');
  assert.deepEqual(picked, [[10, 50]], 'newest first: Renata was discussed last');
  assert.match(captionOf(d.telegram.calls[0]), /Eddie Watson/);

  reset(seed());
  const unsure = deps({ pickPost: async () => null });
  assert.equal(await processReview(review({ safetyKey: 'message:60', postMessageId: null }), unsure), 'unclear');
  assert.match(unsure.telegram.calls[0].text, /Which driver is this about\?/);
  assert.equal(state.announcements.length, 0);
});

test('not a reply, and nothing about a driver nearby: Safety is asked', async () => {
  reset([msg({ messageId: 70, fromUserId: RECRUITER, text: 'Office is closed' }), say(71, 'not approved')]);
  const d = deps();
  assert.equal(await processReview(review({ safetyKey: 'message:71', postMessageId: null }), d), 'unclear');
  assert.match(d.telegram.calls[0].text, /Which driver is this about\?/);
});

test('an edit that took the words out is not a decision any more', async () => {
  reset([...soloPost(), say(21, 'on it', { replyToMessageId: 10 })]);
  const d = deps();
  assert.equal(await processReview(review({ safetyKey: 'message:21', postMessageId: 10 }), d), 'unclear');
  assert.equal(d.telegram.calls.length, 0);
  assert.equal(state.finished.at(-1).outcome.reason, 'not_a_decision');
});
