'use strict';

/**
 * The buttons under a Board ↔ Bitrix question. DELIBERATELY THIN: who may
 * tap, what a tap does and what it answers live in
 * services/boardBitrix/buttons.js, tested without a bot.
 *
 * It cannot throw: a rejection inside a handler reaches index.js's
 * `unhandledRejection` hook, which exits the process.
 */

const { handleBoardBitrixButton } = require('../../services/boardBitrix/buttons');
const { CALLBACK_PATTERN } = require('../../lib/boardBitrix/actions');

function registerBoardBitrixButtonHandlers(bot, { handle = handleBoardBitrixButton } = {}) {
  bot.action(CALLBACK_PATTERN, async (ctx) => {
    let out = { text: 'Something went wrong — nothing changed.', alert: true };
    try {
      out = await handle({
        data: ctx.callbackQuery?.data,
        chatId: ctx.callbackQuery?.message?.chat?.id,
        messageId: ctx.callbackQuery?.message?.message_id,
        telegramUserId: ctx.from?.id,
        fromIsBot: Boolean(ctx.from?.is_bot),
      });
    } catch (err) {
      console.error('[BOARD-BITRIX] button handler failed:', err.message);
    }
    try {
      await ctx.answerCbQuery(String(out.text).slice(0, 200), { show_alert: Boolean(out.alert) });
    } catch { /* too old to answer; the answer under the question says it */ }
  });
}

module.exports = { registerBoardBitrixButtonHandlers };
