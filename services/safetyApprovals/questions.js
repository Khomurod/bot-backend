'use strict';

/**
 * Asking Safety, and taking the question back (owner, 28 November 2026).
 *
 * On 27 November one message from Safety got two questions within a minute:
 * one on what she first wrote, one after she edited it — and the edit had
 * made it clear. So:
 *
 *   NOT AT ONCE    a question waits until the message has been left alone for
 *                  ASK_AFTER_SECONDS: people finish and fix their messages,
 *                  and an edit re-reads it anyway. A decision that is clear
 *                  still posts in seconds — only a question waits.
 *   ONCE           one question per Safety message, whatever its edits; the
 *                  bot remembers it (safety_approval_reviews.question_message_id).
 *   TAKEN BACK     when the message turns out to be clear, or not a decision
 *                  after all, the bot deletes its question.
 */

const reviews = require('../../database/safetyApprovals/reviews');
const { askSafety } = require('./announcer');

const ASK_AFTER_SECONDS = 180;

function log(text) {
  console.log(`[SAFETY APPROVALS] ${text}`);
}

/** When the message last changed: its newest item's edit or send. */
function lastTouched(rows) {
  const times = (rows || []).flatMap((r) => [r.editedAt, r.sentAt])
    .map((t) => (t ? new Date(t).getTime() : NaN))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

/**
 * Ask Safety about this message — later, once, or not again.
 * @returns {Promise<'waiting'|'unclear'>}
 */
async function askOnce(review, deps, {
  triggerRows, triggerRow, reason, extra = {}, now = Date.now(),
}) {
  const touched = lastTouched(triggerRows);
  const age = touched == null ? Infinity : (now - touched) / 1000;
  if (age < ASK_AFTER_SECONDS) {
    // A wait, not a failure: the attempt is given back.
    await reviews.retryReview(review, { delaySeconds: Math.ceil(ASK_AFTER_SECONDS - age) + 1, countAttempt: false });
    return 'waiting';
  }
  if (review.questionMessageId) {
    await reviews.finishReview(review, { status: 'unclear', outcome: { ...extra, reason, asked: 'already' } });
    return 'unclear';
  }
  const questionId = await askSafety(deps.telegram, {
    chatId: review.chatId, threadId: triggerRow.threadId, replyTo: triggerRow.messageId, reason,
  });
  if (questionId) await reviews.recordQuestion(review.id, questionId).catch(() => {});
  await reviews.finishReview(review, { status: 'unclear', outcome: { ...extra, reason, asked: Boolean(questionId) } });
  return 'unclear';
}

/** The message is clear now (or not a decision at all): delete the question, if one was asked. Never throws. */
async function takeBackQuestion(review, deps) {
  if (!review.questionMessageId) return false;
  try {
    await deps.telegram.deleteMessage(review.chatId, review.questionMessageId);
  } catch (err) {
    log(`review ${review.id}: could not delete the earlier question (${String(err?.message || err).slice(0, 120)})`);
  }
  await reviews.clearQuestion(review.id).catch(() => {});
  return true;
}

module.exports = {
  ASK_AFTER_SECONDS, askOnce, takeBackQuestion, lastTouched,
};
