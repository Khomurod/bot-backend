'use strict';

/**
 * The Move / No / "search again" buttons on the Bitrix stage proposals in the
 * recruiting group. DELIBERATELY THIN: who may press, what a press does and
 * what it answers are decided in services/hiringStages/actions.js, where they
 * are tested without a bot.
 *
 * It cannot throw: a rejection inside a handler reaches index.js's
 * `unhandledRejection` hook, which exits the process.
 */

const { handleStageButton } = require('../../services/hiringStages/actions');
const { CALLBACK_PATTERN } = require('../../lib/hiringStages/messages');

function registerHiringStageHandlers(bot) {
  bot.action(CALLBACK_PATTERN, async (ctx) => {
    let reply = { text: 'Something went wrong — nothing changed.', alert: true };
    try {
      reply = await handleStageButton({
        action: ctx.match[1],
        proposalId: Number(ctx.match[2]),
        chatId: ctx.callbackQuery?.message?.chat?.id,
        from: ctx.from,
      }, { telegram: ctx.telegram });
    } catch (err) {
      console.error('[HIRING STAGES] button failed:', err.message);
    }
    try {
      await ctx.answerCbQuery(reply.text.slice(0, 200), { show_alert: Boolean(reply.alert) });
    } catch { /* the press is too old to answer; the message already says the outcome */ }
  });
}

module.exports = { registerHiringStageHandlers };
