/**
 * Inline-button handlers for home-time request cards (Approve / Do Not Approve).
 * Only the configured approvers (@tomr_robins0n / @SaffieBNett) may decide;
 * anyone else gets an alert and the card is left untouched. On approval, the
 * employee group is notified.
 *
 * Kept free of any require on the request *service's* bot dependency (the
 * service never requires bot.js) to avoid a circular dependency.
 */
const ht = require('../database/homeTime');
const {
  CALLBACK_PREFIX,
  applyHomeTimeDecision,
} = require('../services/homeTimeRequestService');
const { isHomeTimeApprover } = require('../services/homeTimeRequestConstants');

function registerHomeTimeRequestHandlers(bot) {
  bot.action(new RegExp(`^${CALLBACK_PREFIX}:(approve|deny):(\\d+)$`), async (ctx) => {
    try {
      const decision = ctx.match[1] === 'approve' ? 'approved' : 'denied';
      const requestId = parseInt(ctx.match[2], 10);
      const from = ctx.from || {};

      if (!isHomeTimeApprover(from)) {
        await ctx.answerCbQuery(
          'Only the assigned managers can approve or deny home time.',
          { show_alert: true }
        );
        return;
      }

      const current = await ht.getHomeTimeRequestById(requestId);
      if (!current) {
        await ctx.answerCbQuery('This request is no longer available.');
        return;
      }

      // Only act on the live card this button belongs to.
      const callbackChatId = ctx.callbackQuery?.message?.chat?.id;
      const callbackMessageId = ctx.callbackQuery?.message?.message_id;
      const isCurrentCard = String(callbackChatId) === String(current.telegram_chat_id)
        && String(callbackMessageId) === String(current.telegram_message_id);
      if (!isCurrentCard) {
        await ctx.answerCbQuery('This is an old or invalid request card.', { show_alert: true });
        return;
      }

      if (current.status !== 'pending') {
        const by = current.decided_by_username ? `@${current.decided_by_username}` : 'a manager';
        await ctx.answerCbQuery(`Already ${current.status} by ${by}.`);
        return;
      }

      // Route through the SHARED decision workflow so a Telegram-button decision
      // has the exact same business result as an admin-panel decision (atomic
      // guard, card settle, reminders stopped, approval announcement).
      const result = await applyHomeTimeDecision(ctx.telegram, requestId, {
        decision,
        decidedByUsername: from.username || null,
        decidedByUserId: from.id || null,
        via: 'telegram',
      });

      if (!result.ok) {
        if (result.code === 'invalid_dates') {
          await ctx.answerCbQuery(
            'Missing or invalid home-time dates — fix them in the admin panel first.',
            { show_alert: true }
          );
        } else if (result.code === 'already_decided' || result.code === 'conflict') {
          await ctx.answerCbQuery('This request was just decided by someone else.');
        } else {
          await ctx.answerCbQuery('This request is no longer available.');
        }
        return;
      }

      await ctx.answerCbQuery(decision === 'approved' ? '✅ Approved.' : '❌ Not approved.');
      console.log(`[HOME-TIME-REQ] Request #${requestId} ${decision} by @${from.username || from.id} (telegram)`);
    } catch (err) {
      console.error('[HOME-TIME-REQ] Callback error:', err.message);
      try { await ctx.answerCbQuery('An error occurred.'); } catch (_) { /* ignore */ }
    }
  });

  console.log('[HOME-TIME-REQ] Home-time request decision handlers registered.');
}

module.exports = { registerHomeTimeRequestHandlers };
