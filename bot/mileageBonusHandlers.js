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
const {
  isAccountingUser,
  BONUS_GROUP_CHAT_ID,
  BONUS_STATUS,
} = require('../services/mileageBonusConstants');
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

      if (!isAccountingUser(from)) {
        await ctx.answerCbQuery(
          'Only approved accounting users can confirm this bonus.',
          { show_alert: true }
        );
        return;
      }

      const current = await mb.getBonusNotificationById(notificationId);
      if (!current) {
        await ctx.answerCbQuery('This bonus is no longer available.');
        return;
      }
      const callbackChatId = ctx.callbackQuery?.message?.chat?.id;
      const callbackMessageId = ctx.callbackQuery?.message?.message_id;
      const isCurrentCard = String(callbackChatId) === String(BONUS_GROUP_CHAT_ID)
        && String(callbackChatId) === String(current.telegram_chat_id)
        && String(callbackMessageId) === String(current.telegram_message_id);
      if (!isCurrentCard) {
        await ctx.answerCbQuery('This is an old or invalid bonus card.', { show_alert: true });
        return;
      }
      if (!(await mb.isDriverActive(current.driver_normalized_name))) {
        await ctx.answerCbQuery('This driver is inactive; the bonus cannot be changed.', { show_alert: true });
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
        if (record.status === 'pending' && record.action_state !== 'idle') {
          await ctx.answerCbQuery('This bonus is currently being updated.');
          return;
        }
        if (record.status === 'pending') {
          await ctx.answerCbQuery('This driver is no longer eligible for this action.');
          return;
        }
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
          let followup = null;
          try {
            followup = await safeSend(() => ctx.telegram.sendMessage(
              chatId,
              buildRejectionFollowupText(record, from.username),
              { parse_mode: 'HTML' }
            ));
            const stored = await mb.setBonusNotificationFollowupMessage(record.id, followup?.message_id || null);
            if (!stored) throw new Error('Could not record the rejection follow-up message.');
          } catch (err) {
            if (followup?.message_id) {
              await ctx.telegram.deleteMessage(chatId, followup.message_id).catch(() => {});
            }
            console.warn('[MILEAGE-BONUS] Rejection follow-up failed:', err.message);
          }
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
