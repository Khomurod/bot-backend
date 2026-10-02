'use strict';

/**
 * Reading a reply in the notification group and acting on it.
 *
 * THE GATES, IN ORDER, AND WHY THIS ORDER. Each one is cheaper than the next
 * and each rejects a whole class, so a group carrying ordinary chatter costs
 * almost nothing:
 *
 *   1. shape          not a group, a bot, no `reply_to_message`, no text →
 *                     not ours, and NOT ONE DATABASE QUERY IS MADE. This is
 *                     the common case by orders of magnitude: people talking
 *                     to each other.
 *   2. switched off   `control_settings.enabled = false` → silence, not a
 *                     refusal message. An off switch that announces itself in
 *                     the chat is not off.
 *   3. is it ours     the replied-to message must be a notice WE sent that
 *                     carries a question. A reply to any other message of ours
 *                     is somebody talking, not answering.
 *   4. WHO            the allow-list. Recorded either way — "a stranger
 *                     answered an operational question" is worth a trace — but
 *                     never obeyed and never answered. Answering would tell an
 *                     unauthorised person that their reply was read, which is
 *                     an invitation.
 *   5. redelivery     `recordReply` claims (chat, message). A null claim means
 *                     this exact reply is already recorded; stop.
 *   6. still open     the finding is re-read LIVE. Minutes have passed since
 *                     the question; somebody may have fixed it in the admin.
 *   7. what it means  the deterministic parser first, ALWAYS. A model is
 *                     reached only when that returns `unclear`, and even then
 *                     it may only pick from what the question offered — see
 *                     `services/control/aiIntent.js`.
 *   8. do it          `executeOffered`, the only writer. A "no" is then
 *                     remembered against the CONDITION, so the next sweep does
 *                     not ask it again.
 *
 * Gates 6 to 8 live in `answerQuestion.js`, shared with the Yes / No / Later
 * buttons (`buttonHandler.js`), so a tap and a typed word take one path.
 *
 * The acknowledgement goes back as a REPLY to the operator's own message, so a
 * busy group shows the answer under the question rather than at the bottom.
 */
const defaultSettings = require('../../database/controlSettings');
const defaultOperators = require('../../database/controlOperators');
const defaultReplies = require('../../database/controlReplies');
const defaultNotices = require('../../database/operationalNotifications');
const defaultFindings = require('../../database/operationalFindings');
const defaultSend = require('../notifications/send');
const { parseIntent } = require('../../lib/control/intent');
const { executeOffered } = require('./actions');
const { readReplyWithAi } = require('./aiIntent');
const { rememberAnswerFor } = require('./memory');
const defaultEngineering = require('../../database/engineeringRequests');
const { answerQuestion } = require('./answerQuestion');

function defaultDeps() {
  return {
    settings: defaultSettings,
    operators: defaultOperators,
    replies: defaultReplies,
    notices: defaultNotices,
    findings: defaultFindings,
    parseIntent,
    readReplyWithAi,
    executeOffered,
    rememberAnswerFor,
    fileRequest: defaultEngineering.fileRequest,
    notify: defaultSend.notify,
    // Injected rather than imported so a test never reaches the outbox, and so
    // this module has no opinion about how a message is sent.
    ack: null,
  };
}

const GROUP_TYPES = new Set(['group', 'supergroup']);

/**
 * @param {object} reply  { chatId, messageId, repliedToMessageId, text,
 *                          telegramUserId, chatType, fromIsBot }
 * @returns {Promise<{handled:boolean, outcome?:string, reason?:string}>}
 *   never throws — a failure here must not break the group message pipeline.
 */
async function handleControlReply(reply, deps = defaultDeps()) {
  const {
    chatId, messageId, repliedToMessageId, text,
    telegramUserId, chatType, fromIsBot,
  } = reply || {};

  // ── 1. shape ──────────────────────────────────────────────────────────────
  if (!GROUP_TYPES.has(chatType)) return { handled: false, reason: 'not_a_group' };
  if (fromIsBot) return { handled: false, reason: 'from_a_bot' };
  if (repliedToMessageId == null || messageId == null || chatId == null) {
    return { handled: false, reason: 'not_a_reply' };
  }
  if (!String(text || '').trim()) return { handled: false, reason: 'no_text' };

  try {
    // ── 3. is it ours ───────────────────────────────────────────────────────
    //
    // BEFORE the enabled check reads anything else, because this is what tells
    // an ordinary group message from an answer. A chat full of drivers replying
    // to each other must not cost a settings read each time — but it must cost
    // one lookup, and this is it.
    const notice = await deps.notices.findNoticeByTelegramMessage(chatId, repliedToMessageId);
    if (!notice || !notice.question) return { handled: false, reason: 'not_a_question' };

    // ── 2. switched off ─────────────────────────────────────────────────────
    const settings = await deps.settings.getControlSettings();
    if (settings.enabled === false) {
      await deps.replies.recordReply({
        notificationId: notice.id, chatId, replyMessageId: messageId,
        repliedToMessageId, telegramUserId, authorised: false,
        rawText: text, outcome: 'ignored_disabled', findingId: notice.findingId,
      }).catch(() => null);
      return { handled: true, outcome: 'ignored_disabled' };
    }

    // ── 4. WHO ──────────────────────────────────────────────────────────────
    const authorised = await deps.operators.isControlOperator(telegramUserId);

    // ── 5. redelivery ───────────────────────────────────────────────────────
    const claim = await deps.replies.recordReply({
      notificationId: notice.id, chatId, replyMessageId: messageId,
      repliedToMessageId, telegramUserId, authorised,
      rawText: text,
      outcome: authorised ? 'no_op' : 'ignored_unauthorised',
      findingId: notice.findingId,
    });
    if (!claim) return { handled: true, outcome: 'redelivery' };

    if (!authorised) {
      // Recorded, never answered. See the header.
      return { handled: true, outcome: 'ignored_unauthorised' };
    }

    return await answerQuestion({
      reply, notice, claim, settings, text,
    }, deps);
  } catch (err) {
    console.warn('[CONTROL] reply handling failed:', err.message);
    return { handled: false, reason: 'error' };
  }
}

module.exports = { handleControlReply, defaultDeps };
