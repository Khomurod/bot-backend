'use strict';

/**
 * Safety answering the bot's own post in the approvals topic (owner, 27
 * November 2026; the words are lib/safetyApprovals/withdrawal.js).
 *
 *   it was not a decision  → the post is re-captioned WITHDRAWN, with Safety's
 *                            words; the withdrawal becomes the driver's latest
 *                            decision on that post, so the real one, when it
 *                            comes, is posted. Nothing new is written.
 *   anything else          → nothing. Never a question, never a model.
 *
 * A #Approved / #NotApproved under the bot's post is not handled here: the
 * reviewer reads it as a decision on the driver's original post.
 */

const reviews = require('../../database/safetyApprovals/reviews');
const { isWithdrawal, withdrawalNote } = require('../../lib/safetyApprovals/withdrawal');
const { buildCaption, postLink } = require('../../lib/safetyApprovals/announcement');
const { personName } = require('../../lib/safetyApprovals/postDetails');
const { resolvePost } = require('./postLocator');
const { recaptionDecision, mediaFor } = require('./announcer');

function log(text) {
  console.log(`[SAFETY APPROVALS] ${text}`);
}

async function stayQuiet(review, reason) {
  await reviews.finishReview(review, { status: 'unclear', outcome: { reason } });
  return 'unclear';
}

/**
 * @param {object} review
 * @param {object} deps          { telegram, settings }
 * @param {object} args
 * @param {object} args.announcement  database/safetyApprovals/reviews.js findAnnouncementByTopicMessage
 * @param {string} args.triggerText   Safety's reply
 * @param {object} args.triggerRow    the reply as captured (who wrote it)
 * @returns {Promise<string>} withdrawn | unclear — a Telegram failure throws, for the retry
 */
async function answerBotPost(review, deps, { announcement, triggerText, triggerRow }) {
  const { chatId } = review;
  if (!isWithdrawal(triggerText)) return stayQuiet(review, 'reply_to_bot_post');

  // Only the post that still stands for that driver: a later decision, or an
  // earlier withdrawal, already replaced it.
  const latest = await reviews.latestAnnouncement(chatId, announcement.postMessageId, announcement.driverKey);
  if (!latest || latest.id !== announcement.id || latest.decision === 'withdrawn') {
    return stayQuiet(review, 'bot_post_not_current');
  }
  const reservation = await reviews.reserveAnnouncement({
    chatId,
    postMessageId: announcement.postMessageId,
    driverKey: announcement.driverKey,
    driverName: announcement.driverName,
    decision: 'withdrawn',
    reviewId: review.id,
  });
  if (!reservation) return stayQuiet(review, 'bot_post_not_current');

  // The recruiter's words, when the post is still kept (60 days); the name alone otherwise.
  const post = await resolvePost(chatId, announcement.postMessageId, deps.settings.safetyUserIds).catch(() => null);
  const caption = buildCaption({
    decision: 'withdrawn',
    postText: post?.text || '',
    name: announcement.driverName,
    nameInStatus: true,
    decidedBy: personName(triggerRow.fromName),
    reason: withdrawalNote(triggerText),
    recruiterName: post ? personName(post.recruiterName) : null,
    link: post ? postLink(chatId, post.anchorId) : null,
  });
  const messageId = announcement.topicMessageIds[0];
  try {
    await recaptionDecision(deps.telegram, {
      chatId, messageId, caption, asText: post ? mediaFor(post.images).ids.length === 0 : null,
    });
  } catch (err) {
    // Not edited: give the withdrawal back so the retry can make it.
    await reviews.releaseAnnouncement(reservation.id).catch(() => {});
    throw err;
  }
  await reviews.completeAnnouncement(reservation.id, [messageId])
    .catch((err) => log(`review ${review.id}: withdrawn, but not recorded where (${String(err.message).slice(0, 120)})`));
  await reviews.finishReview(review, {
    status: 'withdrawn',
    outcome: { withdrawn: [announcement.driverName], was: announcement.decision },
  });
  log(`review ${review.id}: Safety withdrew a posted ${announcement.decision}; the post is marked`);
  return 'withdrawn';
}

module.exports = { answerBotPost };
