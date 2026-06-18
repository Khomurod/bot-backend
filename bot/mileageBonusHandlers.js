/**
 * Inline-button handlers for mileage bonus cards (Paid / Rejected in Pay).
 * Only accounting usernames may decide; others get an alert and the card is
 * left untouched. On rejection, the escalation users are tagged for review.
 *
 * Kept free of any require on the bonus *service* (which imports the bot) to
 * avoid a circular dependency.
 */
const mb = require('../database/mileageBonus');
const { safeSend } = require('../services/telegramHtml');
const { isAccountingUsername, BONUS_STATUS } = require('../services/mileageBonusConstants');
const {
  buildDecidedCardText,
  buildRejectionFollowupText,
} = require('../services/mileageBonusMessages');

function registerMileageBonusHandlers(bot) {
  bot.action(/^mbonus:(paid|rej):(\d+)$/, async (ctx) => {
    try {
      const decision = ctx.match[1] === 'paid' ? BONUS_STATUS.PAID : BONUS_STATUS.REJECTED;
      const notificationId = parseInt(ctx.match[2], 10);
      const from = ctx.from || {};

      if (!isAccountingUsername(from.username)) {
        await ctx.answerCbQuery(
          'Only @cameron_acc or @Ellaaccounting can confirm this bonus.',
          { show_alert: true }
        );
        return;
      }

      const { record, alreadyDecided } = await mb.decideBonusNotification(notificationId, {
        status: decision,
        username: from.username || null,
        userId: from.id || null,
      });

      if (!record) {
        await ctx.answerCbQuery('This bonus is no longer available.');
        return;
      }

      if (alreadyDecided) {
        const by = record.decided_by_username ? `@${record.decided_by_username}` : 'accounting';
        await ctx.answerCbQuery(`Already ${record.status} by ${by}.`);
        return;
      }

      // Update the original card: status footer, buttons removed.
      try {
        await ctx.editMessageText(
          buildDecidedCardText(record, decision, from.username),
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        console.warn('[MILEAGE-BONUS] Could not edit bonus card:', err.message);
      }

      await ctx.answerCbQuery(
        decision === BONUS_STATUS.PAID ? '✅ Marked as paid.' : '❌ Marked as rejected.'
      );

      if (decision === BONUS_STATUS.REJECTED) {
        const chatId = ctx.callbackQuery?.message?.chat?.id;
        if (chatId) {
          await safeSend(() => ctx.telegram.sendMessage(
            chatId,
            buildRejectionFollowupText(record, from.username),
            { parse_mode: 'HTML' }
          )).catch((err) => console.warn('[MILEAGE-BONUS] Rejection follow-up failed:', err.message));
        }
      }

      console.log(
        `[MILEAGE-BONUS] ${record.driver_name} ${record.threshold_miles}mi `
        + `marked ${decision} by @${from.username}`
      );
    } catch (err) {
      console.error('[MILEAGE-BONUS] Callback error:', err.message);
      try { await ctx.answerCbQuery('An error occurred.'); } catch (e) { /* ignore */ }
    }
  });

  console.log('[MILEAGE-BONUS] Bonus decision handlers registered.');
}

module.exports = { registerMileageBonusHandlers };
