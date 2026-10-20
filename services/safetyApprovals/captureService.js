'use strict';

/**
 * Listening to the recruiting group, quietly.
 *
 * ONE GATE: the chat id. Every message the bot sees is asked about, and the
 * answer is no — no row, no log line — unless Safety Approvals is switched on
 * and pointed at this chat. Safety Approvals never writes in the recruiting
 * group's conversation; it only posts decisions in the approvals topic. (The
 * Bitrix stage proposals, when switched on, reply in General — see
 * services/hiringStages/conversationQueue.js, queued from here.)
 *
 * Every message in the group is stored (lib/safetyApprovals/messageShape.js),
 * because Safety answers a post the bot must already have seen. A message from
 * one of the people named as Safety that REPLIES to something queues a review;
 * so does any item of a reply album, which re-arms the settle delay so the
 * reply is read once it has stopped arriving.
 *
 * IT NEVER THROWS AT THE BOT. It returns a reason instead, like
 * services/finance/captureService.js, and logs ids only — these messages are
 * drivers' names and phone numbers.
 */

const { shapeCapturedMessage } = require('../../lib/safetyApprovals/messageShape');
const {
  getSafetyApprovalSettings, markRecruitmentGroup,
} = require('../../database/safetyApprovals/settings');
const messages = require('../../database/safetyApprovals/messages');
const reviews = require('../../database/safetyApprovals/reviews');
const { wakeSafetyApprovalWorker } = require('./worker');
const { noteConversationMessage } = require('../hiringStages/conversationQueue');
const { wakeHiringStageWorker } = require('../hiringStages/worker');

/** How long a reply is left to finish arriving (an album comes item by item). */
const SETTLE_SECONDS = 30;

const markedGroups = new Set();

async function queueReview(shaped, settings) {
  const { chatId } = shaped;
  if (shaped.mediaGroupId) {
    const safetyKey = `album:${shaped.mediaGroupId}`;
    let target = shaped.replyToMessageId;
    if (!target) {
      // Not every item of a reply album is marked as the reply.
      const album = await messages.getMediaGroup(chatId, shaped.mediaGroupId);
      target = album.find((row) => row.replyToMessageId)?.replyToMessageId ?? null;
    }
    if (!target) return null;
    return reviews.enqueueReview({
      chatId, safetyKey, safetyUserId: shaped.fromUserId, postMessageId: target, settleSeconds: SETTLE_SECONDS,
    });
  }
  if (!shaped.replyToMessageId) return null;
  return reviews.enqueueReview({
    chatId,
    safetyKey: `message:${shaped.messageId}`,
    safetyUserId: shaped.fromUserId,
    postMessageId: shaped.replyToMessageId,
    settleSeconds: SETTLE_SECONDS,
  });
}

/**
 * @param {object} message  a Telegram message (new or edited)
 * @returns {Promise<{captured: boolean, queued?: boolean, reason?: string}>}
 */
async function captureSafetyApprovalMessage(message, deps = {}) {
  try {
    const settings = await (deps.getSettings || getSafetyApprovalSettings)();
    const chatId = message?.chat?.id === undefined ? null : String(message.chat.id);
    if (!settings.enabled || !settings.chatId || chatId !== settings.chatId) {
      return { captured: false, reason: 'not_the_recruiting_group' };
    }
    const shaped = shapeCapturedMessage(message);
    if (!shaped || shaped.fromIsBot) return { captured: false, reason: 'not_a_person' };

    await messages.upsertMessage(shaped);

    if (!markedGroups.has(chatId)) {
      markedGroups.add(chatId);
      // Take the group out of every driver feature (see markRecruitmentGroup).
      await markRecruitmentGroup(chatId).catch((err) => {
        markedGroups.delete(chatId);
        console.error('[SAFETY APPROVALS] could not mark the group as recruitment:', err.message);
      });
    }

    // The same conversation, read for a Bitrix stage (services/hiringStages/).
    // Its own failure is its own: it never stops a Safety decision below.
    try {
      if (await (deps.noteConversation || noteConversationMessage)(shaped, settings)) {
        (deps.wakeStages || wakeHiringStageWorker)();
      }
    } catch (err) {
      console.error('[HIRING STAGES] could not queue a conversation:', err.message);
    }

    const fromSafety = shaped.fromUserId !== null && settings.safetyUserIds.includes(String(shaped.fromUserId));
    if (!fromSafety) return { captured: true };

    const queued = await queueReview(shaped, settings);
    if (queued) (deps.wake || wakeSafetyApprovalWorker)();
    return { captured: true, queued: Boolean(queued) };
  } catch (err) {
    console.error('[SAFETY APPROVALS] capture failed:', err.message);
    return { captured: false, reason: 'error' };
  }
}

module.exports = {
  captureSafetyApprovalMessage,
  SETTLE_SECONDS,
  __resetForTests: () => markedGroups.clear(),
};
