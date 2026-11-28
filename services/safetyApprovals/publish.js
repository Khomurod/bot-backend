'use strict';

/**
 * Posting decisions in the approvals topic — every one not posted yet, each
 * reserved BEFORE the send so a failure after Telegram accepted it can never
 * post it twice (database/safetyApprovals/reviews.js reserveAnnouncement).
 * Moved out of reviewer.js so the answer to the bot's own post
 * (botPostReply.js) posts the same way.
 *
 * A decision a model took part in — the words read, the driver chosen from
 * the conversation, the names read off a photo — carries "Read by AI" and
 * how to correct it (owner, 28 November 2026).
 */

const reviews = require('../../database/safetyApprovals/reviews');
const { personName } = require('../../lib/safetyApprovals/postDetails');
const { buildCaption, postLink } = require('../../lib/safetyApprovals/announcement');
const { postDecision } = require('./announcer');

/** The modes in which a model chose who, or what. */
const AI_MODES = Object.freeze(new Set(['model', 'hashtag_model_names', 'judge', 'bot_post_reading']));

function log(text) {
  console.log(`[SAFETY APPROVALS] ${text}`);
}

/**
 * @param {object} review    the review this comes from
 * @param {object} deps      { telegram, settings }
 * @param {object} args
 * @param {object} args.post        lib/safetyApprovals/bundle.js assemblePost
 * @param {object} args.result      { mode, decisions, candidates }
 * @param {object} args.triggerRow  Safety's message (who decided)
 * @returns {Promise<{posted: string[], unchanged: string[]}>}
 */
async function announceDecisions(review, deps, { post, result, triggerRow }) {
  const { chatId } = review;
  const posted = [];
  const unchanged = [];
  const link = postLink(chatId, post.anchorId);
  const readByAi = AI_MODES.has(result.mode);
  for (const decision of result.decisions) {
    // eslint-disable-next-line no-await-in-loop
    const reservation = await reviews.reserveAnnouncement({
      chatId,
      postMessageId: post.anchorId,
      driverKey: decision.key,
      driverName: decision.name,
      decision: decision.decision,
      reviewId: review.id,
    });
    if (!reservation) {
      unchanged.push(decision.name);
      continue;
    }
    const caption = buildCaption({
      decision: decision.decision,
      postText: post.text,
      name: decision.name,
      nameInStatus: (result.candidates || []).length > 1,
      nameFromCdl: decision.nameFromCdl,
      decidedBy: personName(triggerRow.fromName),
      reason: decision.reason,
      recruiterName: personName(post.recruiterName),
      link,
      readByAi,
    });
    let topicMessageIds;
    try {
      // eslint-disable-next-line no-await-in-loop
      topicMessageIds = await postDecision(deps.telegram, {
        chatId, topicId: deps.settings.topicId, caption, images: post.images,
      });
    } catch (err) {
      // Not posted: the retry may post it.
      // eslint-disable-next-line no-await-in-loop
      await reviews.releaseAnnouncement(reservation.id).catch(() => {});
      throw err;
    }
    // Posted. Failing to note where must not make a retry post it again —
    // the reservation already says it went out.
    // eslint-disable-next-line no-await-in-loop
    await reviews.completeAnnouncement(reservation.id, topicMessageIds)
      .catch((err) => log(`review ${review.id}: posted, but not recorded where (${String(err?.message || err).slice(0, 160)})`));
    posted.push(decision.name);
  }
  return { posted, unchanged };
}

module.exports = { announceDecisions, AI_MODES };
