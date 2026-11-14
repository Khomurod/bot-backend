'use strict';

/**
 * Setting ONE emoji reaction on a message — the single implementation.
 *
 * Used by the automatic reactions (services/autoReactionService.js), the
 * driver-group 👍 (services/homeTimeDriverChannel.js), Truck Photos' delivery
 * 👍 (services/truckPhotos/deliver.js) and the recruiting group's answer to a
 * person who asked the bot for a lead (services/hiringStages/requestQueue.js,
 * requested.js). A bot may react only with the emoji Telegram allows it
 * (services/autoReactionConstants.js `ALLOWED_REACTION_EMOJIS`), and setting
 * a reaction replaces the bot's earlier one on that message.
 *
 * THROWS what Telegram throws — whether a reaction matters is the caller's
 * call; `reactQuietly` is the never-throws form.
 */

/** Can this client set a reaction at all (a Telegraf `telegram`, or anything with `callApi`)? */
function canReact(telegram) {
  return typeof telegram?.setMessageReaction === 'function' || typeof telegram?.callApi === 'function';
}

/**
 * @returns {Promise<*>} Telegram's answer
 * @throws when the client cannot react, or Telegram refuses
 */
async function setEmojiReaction(telegram, chatId, messageId, emoji) {
  const reaction = [{ type: 'emoji', emoji }];
  if (typeof telegram?.setMessageReaction === 'function') {
    return telegram.setMessageReaction(chatId, messageId, reaction);
  }
  if (typeof telegram?.callApi === 'function') {
    return telegram.callApi('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction });
  }
  throw new Error('this Telegram client cannot set reactions');
}

/**
 * The same, never throwing: a reaction is a courtesy, never the work itself.
 * Logs `label` and Telegram's words (clipped), never the message.
 * @returns {Promise<boolean>} whether it was set
 */
async function reactQuietly(telegram, chatId, messageId, emoji, label = 'REACTION') {
  if (!chatId || !messageId || !emoji) return false;
  try {
    await setEmojiReaction(telegram, chatId, messageId, emoji);
    return true;
  } catch (err) {
    console.warn(`[${label}] could not react (non-fatal): ${String(err?.message || err).slice(0, 120)}`);
    return false;
  }
}

module.exports = { canReact, setEmojiReaction, reactQuietly };
