'use strict';

/**
 * Listening to the recruiting group, quietly.
 *
 * ONE GATE: the chat id. Every message the bot sees is asked about, and the
 * answer is no — no row, no log line — unless Safety Approvals is switched on
 * and pointed at this chat. Safety Approvals never writes in the recruiting
 * group's conversation; it only posts decisions in the approvals topic. (The
 * Bitrix stage proposals, when switched on, read the conversation from here —
 * services/hiringStages/conversationQueue.js — and write in their own Bitrix
 * topic.)
 *
 * A REPLY THAT MENTIONS THE BOT is a person asking for that lead
 * (services/hiringStages/requestQueue.js): stored flagged `bot_request` — a
 * request, never data — and handed over in its own try, so it can never stop
 * capture or a Safety decision. The bot's id and username come from the
 * handler (ctx.botInfo); none, and nothing mentions the bot.
 *
 * Every message in the group is stored (lib/safetyApprovals/messageShape.js),
 * because Safety answers a post the bot must already have seen. A message from
 * one of the people named as Safety that is a DECISION (a #Approved /
 * #NotApproved hashtag, or the words) queues a review — see queueReview.
 *
 * IT NEVER THROWS AT THE BOT. It returns a reason instead, and logs ids only —
 * these messages are drivers' names and phone numbers.
 */

const { shapeCapturedMessage } = require('../../lib/safetyApprovals/messageShape');
const {
  getSafetyApprovalSettings, markRecruitmentGroup,
} = require('../../database/safetyApprovals/settings');
const messages = require('../../database/safetyApprovals/messages');
const reviews = require('../../database/safetyApprovals/reviews');
const { isDecisionMessage } = require('../../lib/safetyApprovals/trigger');
const { wakeSafetyApprovalWorker } = require('./worker');
const { isBotRequestMessage } = require('../../lib/hiringStages/botRequest');
const { noteConversationMessage } = require('../hiringStages/conversationQueue');
const { noteBotRequest } = require('../hiringStages/requestQueue');
const { wakeHiringStageWorker } = require('../hiringStages/worker');

/**
 * How long a decision is left to finish arriving. An album comes item by item,
 * a second or so apart, and each item re-arms this. Short on purpose: the
 * owner wants a hashtag in the topic "this very second" (20 October 2026).
 */
const SETTLE_SECONDS = 5;

const markedGroups = new Set();

/**
 * Queue a Safety message that is a DECISION — a #Approved / #NotApproved
 * hashtag, or the words "approved" / "not approved" — whether or not it is a
 * reply (lib/safetyApprovals/trigger.js). "On it", "CLH sent" and a bare PDF
 * are stored and never queued: they cost nothing. An album is queued once the
 * item carrying the words has arrived, and each later item re-arms the settle
 * delay so the album is read whole.
 */
async function queueReview(shaped) {
  const { chatId } = shaped;
  if (shaped.mediaGroupId) {
    const album = await messages.getMediaGroup(chatId, shaped.mediaGroupId);
    const words = [...album.map((row) => row.text), shaped.text].filter(Boolean).join('\n');
    if (!isDecisionMessage(words)) return null;
    // Not every item of a reply album is marked as the reply.
    const target = shaped.replyToMessageId ?? album.find((row) => row.replyToMessageId)?.replyToMessageId ?? null;
    return reviews.enqueueReview({
      chatId,
      safetyKey: `album:${shaped.mediaGroupId}`,
      safetyUserId: shaped.fromUserId,
      postMessageId: target,
      settleSeconds: SETTLE_SECONDS,
    });
  }
  if (!isDecisionMessage(shaped.text)) return null;
  return reviews.enqueueReview({
    chatId,
    safetyKey: `message:${shaped.messageId}`,
    safetyUserId: shaped.fromUserId,
    // null: a decision written on its own; the reviewer finds its post.
    postMessageId: shaped.replyToMessageId,
    settleSeconds: SETTLE_SECONDS,
  });
}

/** A person asked the bot for a lead. Its own failure is its own. @returns whether a read was queued */
async function noteRequest(message, settings, deps) {
  try {
    const thread = await (deps.noteRequest || noteBotRequest)(message, settings, {
      botInfo: deps.botInfo, telegram: deps.telegram,
    });
    if (thread) (deps.wakeStages || wakeHiringStageWorker)();
    return Boolean(thread);
  } catch (err) {
    console.error('[HIRING STAGES] could not take a request to the bot:', err.message);
    return false;
  }
}

/**
 * @param {object} message  a Telegram message (new or edited)
 * @param {object} [deps]   botInfo and telegram from the handler; the rest are test seams
 * @returns {Promise<{captured: boolean, queued?: boolean, requested?: boolean, reason?: string}>}
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
    shaped.botRequest = isBotRequestMessage(message, deps.botInfo);

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
    // Its own failure is its own: it never stops a Safety decision below. A
    // request to the bot is not part of the conversation — it asks for a read.
    const requested = shaped.botRequest ? await noteRequest(message, settings, deps) : false;
    try {
      if (!shaped.botRequest && await (deps.noteConversation || noteConversationMessage)(shaped, settings)) {
        (deps.wakeStages || wakeHiringStageWorker)();
      }
    } catch (err) {
      console.error('[HIRING STAGES] could not queue a conversation:', err.message);
    }

    const fromSafety = shaped.fromUserId !== null && settings.safetyUserIds.includes(String(shaped.fromUserId));
    if (!fromSafety) return requested ? { captured: true, requested } : { captured: true };

    const queued = await queueReview(shaped);
    if (queued) (deps.wake || wakeSafetyApprovalWorker)();
    return { captured: true, queued: Boolean(queued), ...(requested ? { requested } : {}) };
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
