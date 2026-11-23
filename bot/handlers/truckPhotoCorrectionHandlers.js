'use strict';

/**
 * A person answering a hand-over PDF (services/truckPhotos/correction.js), and
 * the Yes / No about the profile's truck number
 * (services/truckPhotos/profileQuestion.js).
 *
 * DELIBERATELY THIN: what counts, who may correct and what happens are decided
 * in the services, tested without a bot.
 *
 *   PRIVATE CHAT  a reply to one of the bot's Truck Photos messages there is
 *                 CONSUMED, so the anonymous-feedback prompt in the same chat
 *                 (registered later) never sees it. Anything else goes on.
 *   DRIVER GROUP  a reply that tags the bot is taken up, and the message ALWAYS
 *                 goes on: everything after this sees the group exactly as before.
 *
 * Registered right after the photo observer and before the control channel.
 * IT CANNOT THROW: a rejection inside a handler reaches index.js's
 * `unhandledRejection` hook, which exits the process.
 */

const { takeCorrection } = require('../../services/truckPhotos/correction');
const { handleProfileButton, CALLBACK_PATTERN } = require('../../services/truckPhotos/profileQuestion');
const { mentionsBot, withoutBotMention } = require('../../lib/telegram/botMention');
const { senderName, replyTarget } = require('../../lib/telegram/messageParts');

function registerTruckPhotoCorrectionHandlers(bot, { take = takeCorrection, press = handleProfileButton } = {}) {
  bot.on('message', async (ctx, next) => {
    const msg = ctx.message;
    const type = ctx.chat?.type;
    try {
      if (type === 'private' && msg?.reply_to_message && !ctx.from?.is_bot) {
        const out = await take({
          source: 'private',
          chatId: ctx.chat.id,
          messageId: msg.message_id,
          replyToMessageId: msg.reply_to_message.message_id,
          text: msg.text ?? msg.caption ?? '',
          fromId: ctx.from?.id,
          fromName: senderName(ctx.from),
          telegram: ctx.telegram,
        });
        if (out.handled) return undefined;
      } else if ((type === 'group' || type === 'supergroup') && !ctx.from?.is_bot
        && replyTarget(msg) && mentionsBot(msg, ctx.botInfo)) {
        take({
          source: 'group',
          chatId: ctx.chat.id,
          messageId: msg.message_id,
          replyToMessageId: replyTarget(msg),
          text: withoutBotMention(msg, ctx.botInfo),
          fromId: ctx.from?.id,
          fromName: senderName(ctx.from),
          telegram: ctx.telegram,
        }).catch((err) => console.error('[TRUCK PHOTOS] correction failed:', err?.message || String(err)));
      }
    } catch (err) {
      console.error('[TRUCK PHOTOS] correction handler failed:', err?.message || String(err));
    }
    return next();
  });

  bot.action(CALLBACK_PATTERN, async (ctx) => {
    let out = { text: 'Something went wrong, so nothing changed.', alert: true };
    try {
      out = await press({ data: ctx.callbackQuery?.data, telegramUserId: ctx.from?.id });
    } catch (err) {
      console.error('[TRUCK PHOTOS] profile button failed:', err?.message || String(err));
    }
    if (out.edit) {
      try {
        await ctx.editMessageText(out.edit);
      } catch { /* the question is too old to edit; the answer below still says it */ }
    }
    try {
      await ctx.answerCbQuery(String(out.text).slice(0, 200), { show_alert: Boolean(out.alert) });
    } catch { /* too old to answer */ }
  });
}

module.exports = { registerTruckPhotoCorrectionHandlers };
