'use strict';

/**
 * The owner's reply to a Board ↔ Bitrix question ("done" / "skip").
 *
 * DELIBERATELY THIN, like bot/handlers/lessonReplyHandlers.js: every decision —
 * is this ours, who may answer, what happens — lives in
 * services/boardBitrix/reply.js where it can be tested without a bot.
 *
 * Registered right after the learning questions' handler: these questions
 * carry no `question_json`, so the control channel passes the reply on, the
 * learning handler finds a subject that is not its own and passes it on, and
 * this one takes it. Anything that is not an answer to one of our questions
 * falls through untouched.
 */
const { handleBoardBitrixReply } = require('../../services/boardBitrix/reply');

function registerBoardBitrixReplyHandlers(bot, { handle = handleBoardBitrixReply } = {}) {
  bot.on('message', async (ctx, next) => {
    const msg = ctx.message;
    if (!msg || !msg.reply_to_message || !msg.text) return next();
    let result = { handled: false };
    try {
      result = await handle({
        chatId: ctx.chat?.id,
        chatType: ctx.chat?.type,
        messageId: msg.message_id,
        repliedToMessageId: msg.reply_to_message.message_id,
        text: msg.text,
        telegramUserId: ctx.from?.id,
        fromIsBot: Boolean(ctx.from?.is_bot),
      });
    } catch (err) {
      console.warn('[BOARD-BITRIX] handler error:', err.message);
    }
    if (result.handled) return undefined;
    return next();
  });
}

module.exports = { registerBoardBitrixReplyHandlers };
