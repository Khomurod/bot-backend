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
  buildDecidedCardText,
  announceApproval,
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

      const record = await ht.decideHomeTimeRequest(requestId, {
        status: decision,
        username: from.username || null,
        userId: from.id || null,
      });
      if (!record) {
        // Lost the race — someone decided between our read and write.
        await ctx.answerCbQuery('This request was just decided by someone else.');
        return;
      }

      try {
        await ctx.editMessageText(
          buildDecidedCardText(record, decision, from.username),
          { parse_mode: 'HTML' }
        );
      } catch (err) {
        console.warn('[HOME-TIME-REQ] Could not edit request card:', err.message);
      }

      await ctx.answerCbQuery(decision === 'approved' ? '✅ Approved.' : '❌ Not approved.');

      if (decision === 'approved') {
        await announceApproval(ctx.telegram, record);
      }

      console.log(`[HOME-TIME-REQ] Request #${requestId} ${decision} by @${from.username || from.id}`);
    } catch (err) {
      console.error('[HOME-TIME-REQ] Callback error:', err.message);
      try { await ctx.answerCbQuery('An error occurred.'); } catch (_) { /* ignore */ }
    }
  });

  console.log('[HOME-TIME-REQ] Home-time request decision handlers registered.');
}

module.exports = { registerHomeTimeRequestHandlers };
