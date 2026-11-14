'use strict';

/**
 * A person in the recruiting group ASKED the bot for a lead: a reply to the
 * lead's post that mentions the bot (lib/hiringStages/botRequest.js says
 * when it counts). Called by services/safetyApprovals/captureService.js
 * after the message is stored, inside its own try — a failure here can never
 * stop capture or a Safety decision.
 *
 *   the replied message, as the group shows it NOW
 *     → stored: kept, or refreshed when Telegram's copy (`reply_to_message`)
 *       is a newer edit or other words — people EDIT the post to add the
 *       name or phone, then tag (owner: the tag itself is "not in that
 *       format" — it carries no data);
 *     → never stored (the bot was down when it was posted): rebuilt from that
 *       copy — Telegram sends it in full: text or caption, photo file ids,
 *       media_group_id, author — and stored, flagged `recovered_from_reply`
 *   → the conversation's post (conversationQueue.js `resolveRoot`)
 *   → queued as REQUESTED with a short settle: one minute, not ten
 *     (database/hiringStages/threads.js `requestThread`: the first person to
 *     ask is kept; a second tag only re-queues it)
 *   → 👀 on the tagging message — the request was accepted.
 *
 * The rest is the worker's (requested.js): the card in the Bitrix topic and
 * the final reaction. Nothing is ever WRITTEN in General but reactions.
 *
 * Telegram does not say what a replied-to message itself replied to, so a
 * rebuilt message is taken as a post. A tag the bot cannot place — on a bot's
 * message, or on a reply whose post it never saw — is answered 🤷 at once.
 */

const messages = require('../../database/safetyApprovals/messages');
const threads = require('../../database/hiringStages/threads');
const { shapeCapturedMessage } = require('../../lib/safetyApprovals/messageShape');
const { readBotRequest, postNeedsRefresh, REQUEST_REACTIONS } = require('../../lib/hiringStages/botRequest');
const { reactQuietly } = require('../telegram/reaction');
const { resolveRoot } = require('./conversationQueue');

/** A minute, so an album or an edit made with the tag is in before the read. */
const REQUEST_SETTLE_SECONDS = 60;
const LOG = 'HIRING STAGES';

/**
 * The replied message as the group shows it now: stored as is, refreshed, or
 * rebuilt. @returns {Promise<boolean>} false when it is not a person's message
 */
async function currentRepliedMessage(message) {
  const replied = message.reply_to_message;
  const fresh = shapeCapturedMessage(replied ? { ...replied, chat: replied.chat || message.chat } : null);
  if (!fresh || fresh.fromIsBot) return false;
  const stored = await messages.getMessage(fresh.chatId, fresh.messageId);
  if (postNeedsRefresh(stored, fresh)) {
    // A stored row keeps what it replies to (Telegram leaves that out of the copy).
    await messages.upsertMessage({ ...fresh, recoveredFromReply: true, botRequest: false });
  }
  return true;
}

/**
 * @param {object} message   the Telegram message (already stored by capture)
 * @param {object} settings  Safety Approvals settings
 * @param {{botInfo: object, telegram: object}} context  the bot itself, and its client for reactions
 * @returns {Promise<object|null>} the queued thread, or null
 */
async function noteBotRequest(message, settings, { botInfo, telegram } = {}) {
  const { request } = readBotRequest(message, { botInfo, settings });
  if (!request) return null;
  const chatId = String(message.chat.id);
  const shrug = () => reactQuietly(telegram, chatId, request.requestMessageId, REQUEST_REACTIONS.needsPerson, LOG);

  if (!(await currentRepliedMessage(message))) {
    await shrug();
    return null;
  }
  const rootMessageId = await resolveRoot(chatId, request.replyToMessageId);
  if (!rootMessageId) {
    await shrug();
    return null;
  }
  const thread = await threads.requestThread({
    chatId,
    rootMessageId,
    requestMessageId: request.requestMessageId,
    requestedByUserId: request.requestedByUserId,
    requestedByName: request.requestedByName,
    settleSeconds: REQUEST_SETTLE_SECONDS,
  });
  await reactQuietly(telegram, chatId, request.requestMessageId, REQUEST_REACTIONS.accepted, LOG);
  console.log(`[${LOG}] conversation ${thread?.id ?? '?'} requested by a group member (tag ${request.requestMessageId})`);
  return thread;
}

module.exports = { noteBotRequest, REQUEST_SETTLE_SECONDS };
