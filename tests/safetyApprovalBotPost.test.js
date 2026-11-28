'use strict';

/**
 * The 27 November 2026 case, and the owner's three answers to it:
 *
 *   - "PSP is clean, IF CLH is clean we can hire" is a CONDITION: nothing is
 *     posted, nothing is asked, and no model is asked (a free model had read
 *     it as APPROVED). A hashtag is still the team's explicit decision;
 *   - Safety answering the BOT'S OWN post "I did not approve him yet" marks
 *     that post WITHDRAWN — an edit, nothing sent — and the real decision,
 *     when it comes, is posted; anything else under the bot's post is left
 *     alone, never answered with "reply to the recruiter's post";
 *   - a hashtag under the bot's post is a decision on the driver's post.
 * Names and ids are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const fx = require('./helpers/safetyApprovalFixture');

const {
  state, processReview, SAFETY, AGO, msg, soloPost, deps, review, reset,
} = fx;

const say = (messageId, text, fields = {}) => msg({
  messageId, fromUserId: SAFETY, fromName: 'Aubrey Davis', text, sentAt: AGO(300), ...fields,
});
const noDownload = { download: async () => { throw new Error('nothing may be downloaded'); } };
const captionOf = (call) => call.media?.[0]?.caption ?? call.extra?.caption ?? call.text ?? call.caption;

/** Renata's post, approved by hashtag, and the id of the bot's post in the topic. */
async function approvedPost() {
  reset([...soloPost(), say(21, '#Approved', { replyToMessageId: 10 })]);
  assert.equal(await processReview(review({ safetyKey: 'message:21', postMessageId: 10 }), deps(noDownload)), 'published');
  return state.announcements[0].topicMessageIds[0];
}

test('A CONDITION is not a decision: nothing posted, nobody asked, no model', async () => {
  reset([...soloPost(), say(21, 'PSP is clean, if clh is clean we can hire, let him know please consent it', { replyToMessageId: 10 })]);
  const d = deps(noDownload); // readReply: a model that must not be asked
  assert.equal(await processReview(review({ safetyKey: 'message:21', postMessageId: 10 }), d), 'unclear');
  assert.equal(d.telegram.calls.length, 0, 'silent: no post and no question (owner, 27 November)');
  assert.equal(state.finished.at(-1).outcome.reason, 'conditional');
  assert.equal(state.announcements.length, 0);
});

test('a HASHTAG still decides beside an "if" — it is the team\'s explicit mark', async () => {
  reset([...soloPost(), say(21, '#Approved let me know if he needs the clinic address', { replyToMessageId: 10 })]);
  const d = deps(noDownload);
  assert.equal(await processReview(review({ safetyKey: 'message:21', postMessageId: 10 }), d), 'published');
  assert.match(captionOf(d.telegram.calls[0]), /✅ <b>APPROVED<\/b> by Aubrey Davis/);
});

test('SAFETY WITHDRAWS the bot\'s post: re-captioned in place, nothing sent — and the real #Approved then posts', async () => {
  const botPost = await approvedPost();
  state.rows.push(say(30, 'I did not approve him yet 🗿', { replyToMessageId: botPost, threadId: 45 }));
  const d = deps(noDownload);
  assert.equal(await processReview(review({ id: 2, safetyKey: 'message:30', postMessageId: botPost }), d), 'withdrawn');
  assert.equal(d.telegram.calls.length, 1, 'one edit, no message');
  const [edit] = d.telegram.calls;
  assert.equal(edit.kind, 'edit_caption');
  assert.equal(edit.messageId, botPost);
  assert.match(edit.caption, /^Company Driver - 80 CPM\nRenata Ilves[\s\S]*↩️ <b>WITHDRAWN, NOT DECIDED YET<\/b> — <b>Renata Ilves<\/b> by Aubrey Davis\n📝 Note: I did not approve him yet 🗿/);
  assert.doesNotMatch(edit.caption, /✅/);
  assert.equal(state.announcements.at(-1).decision, 'withdrawn', 'kept as the driver\'s latest decision; nothing deleted');
  assert.equal(state.announcements.length, 2);

  state.rows.push(say(31, 'not yet', { replyToMessageId: botPost, threadId: 45 }));
  const again = deps(noDownload);
  assert.equal(await processReview(review({ id: 3, safetyKey: 'message:31', postMessageId: botPost }), again), 'unclear');
  assert.equal(again.telegram.calls.length, 0, 'already withdrawn: nothing more');

  state.rows.push(say(32, '#Approved', { replyToMessageId: 10 }));
  const real = deps(noDownload);
  assert.equal(await processReview(review({ id: 4, safetyKey: 'message:32', postMessageId: 10 }), real), 'published');
  assert.match(captionOf(real.telegram.calls[0]), /✅ <b>APPROVED<\/b> by Aubrey Davis/, 'the real decision is posted, not swallowed');
});

test('an acknowledgement under the bot\'s post is left alone with no model; a comment, by Claude\'s reading', async () => {
  const botPost = await approvedPost();
  const noClaude = { runCapability: async () => { throw new Error('a model must not be asked'); } };
  for (const [id, text] of [[40, '👍'], [41, 'ok'], [42, 'Thanks!']]) {
    state.rows.push(say(id, text, { replyToMessageId: botPost, threadId: 45 }));
    const d = deps({ ...noDownload, ...noClaude });
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await processReview(review({ id, safetyKey: `message:${id}`, postMessageId: botPost }), d), 'unclear');
    assert.equal(d.telegram.calls.length, 0, `"${text}" is not answered`);
    assert.equal(state.finished.at(-1).outcome.reason, 'reply_to_bot_post');
  }
  state.rows.push(say(43, 'he starts Monday in Chicago', { replyToMessageId: botPost, threadId: 45 }));
  const d = deps({ ...noDownload, runCapability: async () => ({ parsed: { action: 'none', evidence: '', confidence: 95 } }) });
  assert.equal(await processReview(review({ id: 43, safetyKey: 'message:43', postMessageId: botPost }), d), 'unclear');
  assert.equal(d.telegram.calls.length, 0, 'a comment changes nothing and is not answered');
  assert.equal(state.announcements.length, 1);
});

test('#NotApproved under the bot\'s post is a decision on the DRIVER\'S post', async () => {
  const botPost = await approvedPost();
  state.rows.push(say(50, '#NotApproved 2 accidents', { replyToMessageId: botPost, threadId: 45 }));
  const d = deps(noDownload);
  assert.equal(await processReview(review({ id: 5, safetyKey: 'message:50', postMessageId: botPost }), d), 'published');
  assert.match(captionOf(d.telegram.calls[0]), /❌ <b>NOT APPROVED<\/b> by Aubrey Davis\n📝 Reason: 2 accidents/);
  assert.equal(state.announcements.at(-1).postMessageId, state.announcements[0].postMessageId, 'the same driver\'s post');
});

test('an edit Telegram refuses is retried, and the withdrawal is given back meanwhile', async () => {
  const botPost = await approvedPost();
  state.rows.push(say(60, 'wrong driver', { replyToMessageId: botPost, threadId: 45 }));
  const d = deps(noDownload);
  d.telegram.editMessageCaption = async () => { throw new Error('Bad Request: too many requests'); };
  assert.equal(await processReview(review({ id: 6, safetyKey: 'message:60', postMessageId: botPost }), d), 'retry');
  assert.equal(state.announcements.at(-1).decision, 'approved', 'no withdrawal recorded until the post says so');
});

// ── Plain language under the bot's post, read by Claude (owner, 28 November 2026) ──
const claude = (parsed) => ({ runCapability: async () => ({ parsed: { confidence: 95, ...parsed }, provider: 'anthropic', model: 'claude' }) });

test('PLAIN WORDS: "no, he has 3 accidents" under an APPROVED post posts NOT APPROVED, "Read by AI"', async () => {
  const botPost = await approvedPost();
  state.rows.push(say(70, 'no, he has 3 accidents', { replyToMessageId: botPost, threadId: 45 }));
  const d = deps({ ...noDownload, ...claude({ action: 'not_approved', evidence: 'he has 3 accidents' }) });
  assert.equal(await processReview(review({ id: 7, safetyKey: 'message:70', postMessageId: botPost }), d), 'published');
  const caption = captionOf(d.telegram.calls[0]);
  assert.match(caption, /❌ <b>NOT APPROVED<\/b> by Aubrey Davis\n📝 Reason: no, he has 3 accidents/);
  assert.match(caption, /🤖 <i>Read by AI/);
  assert.equal(state.announcements.at(-1).decision, 'not_approved');
});

test('PLAIN WORDS: "hold on with him" is a withdrawal when Claude reads it so', async () => {
  const botPost = await approvedPost();
  state.rows.push(say(71, 'hold on with him for now', { replyToMessageId: botPost, threadId: 45 }));
  const d = deps({ ...noDownload, ...claude({ action: 'withdraw', evidence: 'hold on with him' }) });
  assert.equal(await processReview(review({ id: 8, safetyKey: 'message:71', postMessageId: botPost }), d), 'withdrawn');
  assert.equal(d.telegram.calls[0].kind, 'edit_caption');
  assert.equal(state.finished.at(-1).outcome.via, 'claude');
});

test('PLAIN WORDS ARE CHECKED: words Safety did not write, or an approval with a condition, change nothing', async () => {
  const botPost = await approvedPost();
  state.rows.push(say(72, 'he is fine I think', { replyToMessageId: botPost, threadId: 45 }));
  const made = deps({ ...noDownload, ...claude({ action: 'not_approved', evidence: 'he failed the drug test' }) });
  assert.equal(await processReview(review({ id: 9, safetyKey: 'message:72', postMessageId: botPost }), made), 'unclear');
  assert.equal(made.telegram.calls.length, 0);

  // Withdrawn first; then "we can hire him once the drug test is back" read as approved: a condition.
  state.rows.push(say(73, 'not yet', { replyToMessageId: botPost, threadId: 45 }));
  await processReview(review({ id: 10, safetyKey: 'message:73', postMessageId: botPost }), deps(noDownload));
  state.rows.push(say(74, 'we can hire him once the drug test is back', { replyToMessageId: botPost, threadId: 45 }));
  const cond = deps({ ...noDownload, ...claude({ action: 'approved', evidence: 'we can hire him' }) });
  assert.equal(await processReview(review({ id: 11, safetyKey: 'message:74', postMessageId: botPost }), cond), 'unclear');
  assert.equal(cond.telegram.calls.length, 0, 'a condition never approves');
  assert.equal(state.announcements.at(-1).decision, 'withdrawn');
});
