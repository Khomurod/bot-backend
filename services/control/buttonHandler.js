'use strict';

/**
 * A tap on a button under one of Wenze's questions — Yes / No / Later, or a
 * choice question's own answers (Working / Not working / Later).
 *
 * THE SAME GATES AS A TYPED REPLY, adapted to what a tap is:
 *
 *   1. shape          not one of our buttons, not a group, no message under
 *                     it → not ours, no database query.
 *   2. is it ours     the message the button sits on must be a notice WE sent
 *                     that carries a question — AND the notice id inside the
 *                     button must be that notice. A button copied, forged or
 *                     left over from another message is refused.
 *   3. switched off   silence.
 *   4. WHO            the allow-list. A stranger's tap is recorded and never
 *                     obeyed; the button just stops spinning.
 *   5. once           a question already answered in words is not answered
 *                     again by its stale buttons. Then the claim — ONE BUTTON
 *                     ANSWER PER QUESTION: an operator's tap claims
 *                     `(chat, the question's own message id)`. A
 *                     double tap, or a second operator a second later, finds
 *                     it taken and is told "already answered". A stranger's
 *                     tap is recorded under the NEGATED id instead, so it can
 *                     never take the claim an operator's tap needs — the
 *                     first person to tap is not allowed to be the one who
 *                     decides whether the owner can answer.
 *
 * Then the tap becomes the word it stands for and goes through
 * `answerQuestion.js` exactly as a typed reply does.
 *
 * NEVER THROWS. A failure here must not break any other button in the bot.
 */
const { parseButton, wordFor } = require('../../lib/control/buttons');
const { answerQuestion } = require('./answerQuestion');

const GROUP_TYPES = new Set(['group', 'supergroup']);

/** What a toast may say. Telegram cuts an answer to a tap at 200 characters. */
const TOAST_MAX = 190;

function toast(text) {
  const s = String(text || '');
  return s.length > TOAST_MAX ? `${s.slice(0, TOAST_MAX - 1)}…` : s;
}

/**
 * @param {object} tap  { data, chatId, chatType, messageId, telegramUserId,
 *                        fromIsBot }
 *   `messageId` is the message the button is attached to — the question.
 * @param {object} deps the reply handler's dependency map, plus `clearButtons`
 * @returns {Promise<{handled:boolean, outcome?:string, toast?:string,
 *   clear?:boolean, reason?:string}>}
 *   `clear` says the buttons should come off the question: it has an answer.
 */
async function handleControlButton(tap, deps) {
  const {
    data, chatId, chatType, messageId, telegramUserId, fromIsBot,
  } = tap || {};

  // ── 1. shape ──────────────────────────────────────────────────────────────
  const button = parseButton(data);
  if (!button) return { handled: false, reason: 'not_ours' };
  if (!GROUP_TYPES.has(chatType)) return { handled: true, outcome: 'refused', toast: '' };
  if (fromIsBot || chatId == null || messageId == null) {
    return { handled: true, outcome: 'refused', toast: '' };
  }

  try {
    // ── 2. is it ours ───────────────────────────────────────────────────────
    const notice = await deps.notices.findNoticeByTelegramMessage(chatId, messageId);
    if (!notice || !notice.question || Number(notice.id) !== button.noticeId) {
      return { handled: true, outcome: 'refused', toast: 'This question is no longer open.' };
    }

    // ── 3. switched off ─────────────────────────────────────────────────────
    const settings = await deps.settings.getControlSettings();
    if (settings.enabled === false) return { handled: true, outcome: 'ignored_disabled', toast: '' };

    const offered = notice.question.offeredActions || [];
    const word = wordFor(button.action, offered);
    if (!word || !offered.some((o) => o && o.key === button.action)) {
      return { handled: true, outcome: 'refused', toast: 'That is not one of the answers to this question.' };
    }

    // ── 4. WHO ──────────────────────────────────────────────────────────────
    const authorised = await deps.operators.isControlOperator(telegramUserId);
    const record = {
      notificationId: notice.id,
      chatId,
      repliedToMessageId: messageId,
      telegramUserId,
      authorised,
      rawText: `${word} (button)`,
      findingId: notice.findingId,
    };
    if (!authorised) {
      await deps.replies.recordReply({
        ...record, replyMessageId: -Number(messageId), outcome: 'ignored_unauthorised',
      }).catch(() => null);
      return { handled: true, outcome: 'ignored_unauthorised', toast: '' };
    }

    // ── 5. once ─────────────────────────────────────────────────────────────
    //
    // ANSWERED IN WORDS ALREADY. The typed path closes the notice but cannot
    // take the buttons off it, and a typed "later" leaves the finding OPEN —
    // so without this a tap on the stale Yes would apply a correction to a
    // question already settled. The buttons come off now instead.
    if (notice.answeredAt) {
      return {
        handled: true,
        outcome: 'no_op',
        toast: 'Already answered. To change it, reply to the question in words.',
        clear: true,
      };
    }
    const claim = await deps.replies.recordReply({
      ...record, replyMessageId: messageId, outcome: 'no_op',
    });
    if (!claim) {
      return {
        handled: true,
        outcome: 'redelivery',
        toast: 'Already answered. To change it, reply to the question in words.',
      };
    }

    // The acknowledgement hangs under the question itself: there is no
    // message of the operator's to reply to.
    const reply = { chatId, messageId, telegramUserId };
    const result = await answerQuestion({
      reply, notice, claim, settings, text: word,
    }, deps);
    return {
      handled: true,
      outcome: result.outcome,
      toast: toast(result.message || 'Done.'),
      clear: true,
    };
  } catch (err) {
    console.warn('[CONTROL] button handling failed:', err.message);
    return { handled: true, outcome: 'failed', toast: 'Something went wrong. Reply to the question in words.' };
  }
}

module.exports = { handleControlButton, TOAST_MAX };
