'use strict';

/**
 * Everything Truck Photos sends through Telegram — three things, and nothing in
 * a driver's group but one reaction.
 *
 *   sendPdf          the PDF, to the ONE recipient, privately, from a buffer;
 *   reactDelivered   👍 on the `outbound` / `inbound` message, ONLY after every
 *                    part of the PDF was delivered — the group's sign that it
 *                    went out, without a word written there;
 *   tellRecipient    a short private message to the recipient when no PDF
 *                    could be made (lib/truckPhotos/failureText.js).
 *
 * THE SEND HAS A DEADLINE, as the birthday card does
 * (services/employeeBirthdayWishService.js postBirthdayCard): Telegraf's client
 * has no request timeout of its own, so an upload that never answers would hold
 * the report — and every report queued behind it — for good. Past
 * SEND_DEADLINE_MS the request is aborted, retries included. `safeSend` retries
 * a transient failure and stops at once on a permanent one (403: the recipient
 * never pressed Start, or blocked the bot).
 */

const { safeSend } = require('../telegramHtml');
const { cleanTelegramError } = require('../../lib/telegram/telegramErrors');

const SEND_DEADLINE_MS = 3 * 60 * 1000;
const THUMBS_UP = '👍';

/**
 * Send one PDF. Throws when Telegram refuses it or the deadline passes.
 *
 * @param {object} args
 * @param {object} args.telegram   a Telegraf telegram client
 * @param {string} args.recipient  the recipient's Telegram user id
 * @param {Buffer} args.buffer
 * @param {string} args.fileName
 * @param {string} args.caption    plain text
 */
async function sendPdf({
  telegram, recipient, buffer, fileName, caption, deadlineMs = SEND_DEADLINE_MS,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  timer.unref?.();
  try {
    return await safeSend(() => {
      if (controller.signal.aborted) throw new Error('the PDF took too long to send; it was not sent');
      return telegram.callApi('sendDocument', {
        chat_id: recipient,
        document: { source: buffer, filename: fileName },
        caption,
      }, { signal: controller.signal });
    }, { maxAttempts: 3 });
  } finally {
    clearTimeout(timer);
  }
}

/** 👍 on the trigger message. Never throws: a reaction is a courtesy, not the delivery. */
async function reactDelivered({ telegram, chatId, messageId }) {
  try {
    const reaction = [{ type: 'emoji', emoji: THUMBS_UP }];
    if (typeof telegram?.setMessageReaction === 'function') {
      await telegram.setMessageReaction(chatId, messageId, reaction);
    } else {
      await telegram.callApi('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction });
    }
    return true;
  } catch (err) {
    console.warn('[TRUCK PHOTOS] could not react to the message (non-fatal):', cleanTelegramError(err));
    return false;
  }
}

/** A private message to the recipient. Never throws; false when it did not go out. */
async function tellRecipient({ telegram, recipient, text }) {
  if (!telegram || !recipient || !text) return false;
  try {
    await safeSend(() => telegram.sendMessage(recipient, text), { maxAttempts: 3 });
    return true;
  } catch (err) {
    console.warn('[TRUCK PHOTOS] could not tell the recipient:', cleanTelegramError(err));
    return false;
  }
}

module.exports = {
  SEND_DEADLINE_MS, THUMBS_UP, sendPdf, reactDelivered, tellRecipient,
};
