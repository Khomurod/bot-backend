'use strict';

/**
 * A message in the recruiting group's General topic was captured: queue the
 * candidate conversation it belongs to for a stage read.
 *
 * Called by services/safetyApprovals/captureService.js for every captured
 * message, so it answers "no" fast and cheaply: the proposals switched off, a
 * message in another topic (the approvals topic has a thread id; General has
 * none), or a message that replies to nothing.
 *
 * THE CONVERSATION IS NAMED BY ITS POST. The reply chain is followed back to
 * the message that replies to nothing — the candidate post — and an album is
 * named by its first item, so a reply to the CDL's back and a reply to its
 * front are the same conversation. A chain that leads to a message the bot
 * never saw (from before capture was on) is not queued: there is no post to
 * read.
 */

const messages = require('../../database/safetyApprovals/messages');
const threads = require('../../database/hiringStages/threads');

/** Long enough for Safety's PDFs and then the sentence to arrive as one burst. */
const SETTLE_SECONDS = 90;
const MAX_HOPS = 15;

async function resolveRoot(chatId, replyToMessageId) {
  let id = replyToMessageId;
  for (let hop = 0; hop < MAX_HOPS && id; hop += 1) {
    // eslint-disable-next-line no-await-in-loop
    const m = await messages.getMessage(chatId, id);
    if (!m) return null;
    if (!m.replyToMessageId) {
      if (!m.mediaGroupId) return m.messageId;
      // eslint-disable-next-line no-await-in-loop
      const album = await messages.getMediaGroup(chatId, m.mediaGroupId);
      return Math.min(m.messageId, ...album.map((a) => a.messageId));
    }
    id = m.replyToMessageId;
  }
  return null;
}

/**
 * @param {object} shaped    the stored message (lib/safetyApprovals/messageShape.js)
 * @param {object} settings  Safety Approvals settings
 * @returns {Promise<object|null>} the queued thread, or null
 */
async function noteConversationMessage(shaped, settings) {
  if (!settings.stageProposalsEnabled || shaped.threadId !== null || !shaped.replyToMessageId) return null;
  const rootMessageId = await resolveRoot(shaped.chatId, shaped.replyToMessageId);
  if (!rootMessageId) return null;
  return threads.enqueueThread({
    chatId: shaped.chatId,
    rootMessageId,
    lastMessageId: shaped.messageId,
    settleSeconds: SETTLE_SECONDS,
  });
}

module.exports = { noteConversationMessage, resolveRoot, SETTLE_SECONDS };
