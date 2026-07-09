/**
 * /start handler: group welcome (+ home-time admin-grant deep link) and the
 * private-chat anonymous feedback entry point.
 *
 * Moved verbatim from bot/bot.js.
 */
const { confirmAdminGrant } = require('../../services/groupAccessService');
const { beginAnonymousFeedback } = require('../anonymousFeedbackHandlers');

function registerStartHandler(bot) {
  bot.start(async (ctx) => {
    const chatType = ctx.chat?.type;
    if (chatType === 'group' || chatType === 'supergroup') {
      // Added to a group via the "Request admin" deep link → verify it landed
      // in the intended group and DM the super admin a confirmation.
      const payload = ctx.startPayload || '';
      if (payload.startsWith('htadmin_')) {
        await confirmAdminGrant(bot.telegram, {
          chatTelegramId: ctx.chat.id,
          chatTitle: ctx.chat.title || '',
          payload,
        });
        return;
      }
      await ctx.reply(
        'Wenze Feedback bot is active in this group for driver feedback, broadcasts, and ETA updates.',
      );
      return;
    }
    // Private chat → start the anonymous feedback flow (employee/driver → message).
    await beginAnonymousFeedback(ctx);
  });
}

module.exports = { registerStartHandler };
