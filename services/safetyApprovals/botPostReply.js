'use strict';

/**
 * Safety answering the bot's own post in the approvals topic.
 *
 *   it was not a decision  → the post is re-captioned WITHDRAWN, with Safety's
 *     ("not yet", "I did     words; the withdrawal becomes the driver's latest
 *     not approve him")      decision on that post, so the real one, when it
 *                            comes, is posted. Nothing new is written.
 *   a new decision in      → posted for THAT driver on the driver's post, marked
 *     plain words ("no,      "Read by AI" (owner, 28 November 2026: "let it
 *     3 accidents")          understand plain language")
 *   anything else          → nothing. Never a question.
 *
 * The clear phrases need no model (lib/safetyApprovals/withdrawal.js) and a
 * bare "ok" / 👍 is not even read; the rest is read by Claude into a closed
 * list and checked (lib/safetyApprovals/botPostReading.js). A #Approved /
 * #NotApproved under the bot's post is not handled here: the reviewer reads it
 * as a decision on the driver's original post.
 */

const reviews = require('../../database/safetyApprovals/reviews');
const { isWithdrawal, withdrawalNote } = require('../../lib/safetyApprovals/withdrawal');
const {
  isAcknowledgement, buildBotPostPrompt, validateBotPostReading, verifyBotPostReading,
} = require('../../lib/safetyApprovals/botPostReading');
const { buildCaption, postLink } = require('../../lib/safetyApprovals/announcement');
const { personName } = require('../../lib/safetyApprovals/postDetails');
const { runCapability } = require('../ai/router');
const { resolvePost } = require('./postLocator');
const { recaptionDecision, mediaFor } = require('./announcer');
const { announceDecisions } = require('./publish');
const { driversFromPost } = require('./decide');

const CAPABILITY = 'safety_approval_reading';

function log(text) {
  console.log(`[SAFETY APPROVALS] ${text}`);
}

async function stayQuiet(review, reason) {
  await reviews.finishReview(review, { status: 'unclear', outcome: { reason } });
  return 'unclear';
}

/** Claude reads the reply into one action; checked, never trusted. A failure to reach Claude throws (retry). */
async function readWithClaude({
  driverName, posted, postText, replyText,
}, deps) {
  const run = deps.runCapability || runCapability;
  const { systemText, userText } = buildBotPostPrompt({
    driverName, posted, postText, replyText,
  });
  const answer = await run({
    capability: CAPABILITY, systemText, userText, expects: 'json', validate: validateBotPostReading,
  });
  if (!answer || answer.uncertain) return { action: 'none', why: 'not_sure' };
  return { ...verifyBotPostReading(answer.parsed, { replyText, posted }), provider: answer.provider ?? null, model: answer.model ?? null };
}

/** Mark the bot's post WITHDRAWN — only the post that still stands for that driver. */
async function withdrawPost(review, deps, {
  announcement, latest, post, triggerText, triggerRow, via,
}) {
  const { chatId } = review;
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
    outcome: { withdrawn: [announcement.driverName], was: announcement.decision, via },
  });
  log(`review ${review.id}: Safety withdrew a posted ${announcement.decision}; the post is marked`);
  return 'withdrawn';
}

/** A new decision for that driver, in Safety's plain words: posted on the driver's post, "Read by AI". */
async function decideAgain(review, deps, {
  announcement, post, decision, triggerText, triggerRow, reading,
}) {
  if (!post) return stayQuiet(review, 'post_not_seen');
  const result = {
    mode: 'bot_post_reading',
    decisions: [{
      key: announcement.driverKey,
      name: announcement.driverName,
      decision,
      reason: decision === 'not_approved' ? withdrawalNote(triggerText) : null,
    }],
    candidates: driversFromPost(post.text).candidates,
  };
  const { posted, unchanged } = await announceDecisions(review, deps, { post, result, triggerRow });
  await reviews.finishReview(review, {
    status: 'published',
    outcome: {
      mode: result.mode, decisions: [{ name: announcement.driverName, decision }], posted, unchanged,
      provider: reading.provider ?? null, model: reading.model ?? null,
    },
  });
  return 'published';
}

/**
 * @param {object} review
 * @param {object} deps          { telegram, settings, runCapability? }
 * @param {object} args
 * @param {object} args.announcement  database/safetyApprovals/reviews.js findAnnouncementByTopicMessage
 * @param {string} args.triggerText   Safety's reply
 * @param {object} args.triggerRow    the reply as captured (who wrote it)
 * @returns {Promise<string>} withdrawn | published | unclear — a Telegram or AI failure throws, for the retry
 */
async function answerBotPost(review, deps, { announcement, triggerText, triggerRow }) {
  const { chatId } = review;
  const clear = isWithdrawal(triggerText);
  if (!clear && isAcknowledgement(triggerText)) return stayQuiet(review, 'reply_to_bot_post');

  const latest = await reviews.latestAnnouncement(chatId, announcement.postMessageId, announcement.driverKey);
  // The recruiter's words, when the post is still kept (60 days); the name alone otherwise.
  const post = await resolvePost(chatId, announcement.postMessageId, deps.settings.safetyUserIds).catch(() => null);
  if (clear) {
    return withdrawPost(review, deps, {
      announcement, latest, post, triggerText, triggerRow, via: 'words',
    });
  }

  const reading = await readWithClaude({
    driverName: announcement.driverName,
    posted: latest?.decision || announcement.decision,
    postText: post?.text || '',
    replyText: triggerText,
  }, deps);
  if (reading.action === 'withdraw') {
    return withdrawPost(review, deps, {
      announcement, latest, post, triggerText, triggerRow, via: 'claude',
    });
  }
  if (reading.action === 'approved' || reading.action === 'not_approved') {
    return decideAgain(review, deps, {
      announcement, post, decision: reading.action, triggerText, triggerRow, reading,
    });
  }
  return stayQuiet(review, reading.why ? `reply_to_bot_post:${reading.why}` : 'reply_to_bot_post');
}

module.exports = { answerBotPost };
