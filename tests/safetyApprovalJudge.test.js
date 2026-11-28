'use strict';

/**
 * Hard Safety decisions settled by Claude from the whole conversation, and
 * the questions the bot still asks (owner, 28 November 2026). The case is
 * 27 November's, with made-up names and numbers:
 *
 *   a team post (two drivers); Safety refuses one by hashtag; then sends the
 *   other's files with "but we can hire him", and a minute later edits it to
 *   "... JOHN ARTHUR KOWALSKI #Approved". The bot asked twice.
 *
 * Pinned: the name before the hashtag decides with no model; "him" is
 * settled by Claude reading the conversation, posted "Read by AI"; Claude
 * may only pick a listed driver, must quote Safety, and cannot change a
 * hashtag's status; a question waits three minutes, is asked once, and is
 * deleted when the message turns out clear.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const fx = require('./helpers/safetyApprovalFixture');
const { judgeDecision } = require('../services/safetyApprovals/judge');
const { verifyJudgement, labelDrivers } = require('../lib/safetyApprovals/judge');

const {
  state, processReview, SAFETY, RECRUITER, AGO, msg, photo, pdf, deps, review, reset, model,
} = fx;

const RECRUITER_NAME = 'Sofia B | Recruiting';
function teamPost() {
  return [
    msg({ messageId: 100, fromUserId: RECRUITER, fromName: RECRUITER_NAME, mediaGroupId: 't1', photos: photo('cdl-a'),
      text: 'Team Driver for Unit 028, 95 CPM\n\nNOWAK PETER E\n2+ yrs of exp\n(555) 010-1111\n\nKOWALSKI JOHN A\n2+ yrs of exp\n(555) 010-2222' }),
    msg({ messageId: 101, fromUserId: RECRUITER, fromName: RECRUITER_NAME, mediaGroupId: 't1', photos: photo('cdl-b') }),
  ];
}
const say = (messageId, text, fields = {}) => msg({
  messageId, fromUserId: SAFETY, fromName: 'Aubrey Davis', text, sentAt: AGO(600), ...fields,
});
/** Safety's album of the second driver's files, the words on the last item. */
function kowalskiFiles(text, fields = {}) {
  return [
    msg({ messageId: 120, fromUserId: SAFETY, fromName: 'Aubrey Davis', mediaGroupId: 's9', replyToMessageId: 100,
      documents: pdf('psp', 'JOHN ARTHUR KOWALSKI psp.pdf'), sentAt: AGO(600), ...fields }),
    msg({ messageId: 121, fromUserId: SAFETY, fromName: 'Aubrey Davis', mediaGroupId: 's9',
      documents: pdf('mvr', 'JOHN ARTHUR KOWALSKI mvr.pdf'), text, sentAt: AGO(600), ...fields }),
  ];
}
const noDownload = { download: async () => Buffer.from('x') };
const captionOf = (call) => call.media?.[0]?.caption ?? call.extra?.caption ?? call.text;
const UNCLEAR = { candidates: [], decisions: [] };

test('THE NAME BEFORE THE HASHTAG decides, with no model and no question', async () => {
  reset([...teamPost(), ...kowalskiFiles('but we can hire him JOHN ARTHUR KOWALSKI #Approved')]);
  const d = deps({ ...noDownload, judge: async () => { throw new Error('no model needed'); } });
  assert.equal(await processReview(review({ safetyKey: 'album:s9', postMessageId: 100 }), d), 'published');
  const [album] = d.telegram.calls;
  assert.match(captionOf(album), /✅ <b>APPROVED<\/b> — <b>Kowalski John A<\/b> by Aubrey Davis/);
  assert.doesNotMatch(captionOf(album), /Read by AI/, 'the hashtag and the name decided: no AI');
});

test('"BUT WE CAN HIRE HIM" in a team: Claude reads the conversation and settles it — posted "Read by AI"', async () => {
  reset([
    ...teamPost(),
    say(110, '#NotApproved PETER NOWAK on sap program', { replyToMessageId: 100 }),
    say(111, 'Need accident report for JOHN KOWALSKI', { replyToMessageId: 101 }),
    ...kowalskiFiles('but we can hire him'),
  ]);
  state.announcements.push({
    id: 1, chatId: fx.CHAT, postMessageId: 100, driverKey: 'nowak peter', driverName: 'Nowak Peter E', decision: 'not_approved', topicMessageIds: [600],
  });
  let asked = null;
  const runCapability = async (args) => {
    asked = args;
    return { parsed: { decisions: [{ driver: 'B', decision: 'approved', evidence: 'but we can hire him' }], confidence: 92 }, provider: 'anthropic', model: 'claude-sonnet' };
  };
  const d = deps({
    ...noDownload, readReply: model(UNCLEAR), judge: (args) => judgeDecision(args, { runCapability }),
  });
  assert.equal(await processReview(review({ safetyKey: 'album:s9', postMessageId: 100 }), d), 'published');
  assert.match(asked.userText, /A: Nowak Peter E \(the bot already posted: NOT APPROVED\)/);
  assert.match(asked.userText, /B: Kowalski John A/);
  assert.match(asked.userText, /\[files: JOHN ARTHUR KOWALSKI psp\.pdf\]/);
  assert.match(asked.userText, /Need accident report for JOHN KOWALSKI/);
  assert.match(asked.userText, /but we can hire him .*<- THE MESSAGE TO DECIDE/);
  assert.equal(asked.capability, 'safety_approval_reading', 'Claude only (PAID_ONLY)');
  const caption = captionOf(d.telegram.calls[0]);
  assert.match(caption, /✅ <b>APPROVED<\/b> — <b>Kowalski John A<\/b> by Aubrey Davis/);
  assert.match(caption, /🤖 <i>Read by AI\. Not right\? Reply to this post\.<\/i>/);
  assert.equal(state.finished.at(-1).outcome.mode, 'judge');
  assert.equal(state.finished.at(-1).outcome.rulesAsked, 'unclear');
});

test('CLAUDE IS CHECKED: only a listed driver, Safety\'s own words, and never against the hashtag', () => {
  const drivers = labelDrivers([{ key: 'nowak peter e', name: 'NOWAK PETER E' }, { key: 'kowalski john a', name: 'KOWALSKI JOHN A' }]);
  const ctx = { drivers, decisionText: 'but we can hire him', safetyWords: ['but we can hire him', 'JOHN ARTHUR KOWALSKI psp.pdf'] };
  assert.equal(verifyJudgement({ decisions: [{ driver: 'C', decision: 'approved', evidence: 'but we can hire him' }] }, ctx).decisions.length, 0, 'no driver C');
  assert.equal(verifyJudgement({ decisions: [{ driver: 'B', decision: 'approved', evidence: 'he is clean' }] }, ctx).decisions.length, 0, 'words Safety never wrote');
  assert.equal(verifyJudgement({ decisions: [{ driver: 'B', decision: 'approved', evidence: 'KOWALSKI psp' }] }, ctx).decisions.length, 1, 'a file name is Safety\'s too');
  assert.equal(verifyJudgement({ decisions: [{ driver: 'B', decision: 'not_approved', evidence: 'but we can hire him' }] }, { ...ctx, hashtag: 'approved' }).decisions.length, 0,
    'the hashtag is the status');
  assert.equal(verifyJudgement({ decisions: [{ driver: 'B', decision: 'approved', evidence: 'cannot hire him' }] },
    { ...ctx, decisionText: 'we cannot hire him', safetyWords: ['we cannot hire him'] }).decisions.length, 0, 'an approval beside a refusal');
  assert.equal(verifyJudgement({ decisions: [{ driver: 'B', decision: 'unclear', evidence: 'him' }] }, ctx).decisions.length, 0);
});

test('A QUESTION WAITS: a message touched under three minutes ago is not asked about yet — the attempt is given back', async () => {
  reset([...teamPost(), say(130, '#Approved', { replyToMessageId: 100, sentAt: AGO(30) })]);
  const d = deps(noDownload);
  assert.equal(await processReview(review({ safetyKey: 'message:130', postMessageId: 100 }), d), 'waiting');
  assert.equal(d.telegram.calls.length, 0);
  assert.equal(state.retried.at(-1).countAttempt, false);
  assert.ok(state.retried.at(-1).delaySeconds >= 150 && state.retried.at(-1).delaySeconds <= 151);
});

test('ONCE, AND TAKEN BACK: one question per message, deleted when an edit makes it clear', async () => {
  reset([...teamPost(), say(130, '#Approved', { replyToMessageId: 100 })]);
  const first = deps(noDownload);
  assert.equal(await processReview(review({ safetyKey: 'message:130', postMessageId: 100 }), first), 'unclear');
  assert.equal(first.telegram.calls.length, 1);
  assert.match(first.telegram.calls[0].text, /Which driver is this about\?/);
  const questionId = state.questions.get(1);
  assert.ok(questionId);

  const again = deps(noDownload);
  assert.equal(await processReview(review({ safetyKey: 'message:130', postMessageId: 100, questionMessageId: questionId, revision: 1 }), again), 'unclear');
  assert.equal(again.telegram.calls.length, 0, 'not asked a second time');

  state.rows = state.rows.map((r) => (r.messageId === 130 ? { ...r, text: '#Approved KOWALSKI' } : r));
  const edited = deps(noDownload);
  assert.equal(await processReview(review({ safetyKey: 'message:130', postMessageId: 100, questionMessageId: questionId, revision: 2 }), edited), 'published');
  assert.deepEqual(edited.telegram.calls.map((c) => c.kind), ['album', 'delete']);
  assert.equal(edited.telegram.calls[1].messageId, questionId, 'the question is taken back');
  assert.equal(state.questions.has(1), false);
});
