/**
 * Retires the old Approve / Do Not Approve buttons.
 *
 * Home time is no longer approved. Wenze reports three events — the driver
 * asked, the driver is home, the driver is back on the road — and none of them
 * waits for a manager. New cards therefore carry no buttons at all.
 *
 * But cards posted BEFORE that change are still sitting in the staff group with
 * live buttons on them, and Telegram will keep delivering a press to whatever
 * handler exists. Deleting this handler would make those buttons spin and then
 * silently do nothing, which reads as a broken bot. So the handler stays, and
 * does the honest thing: it says approval is no longer needed, and edits the
 * card so its buttons disappear for everyone.
 *
 * It grants nothing and decides nothing — there is deliberately no manager
 * check here, because there is no longer any decision to protect.
 */
const ht = require('../database/homeTime');
const { CALLBACK_PREFIX } = require('../services/homeTimeRequestService');
const { buildRetiredCardText } = require('../services/homeTimeRequestCards');

const RETIRED_ANSWER = 'Home time no longer needs approval — Wenze tracks it and tells the managers.';

function registerHomeTimeRequestHandlers(bot) {
  bot.action(new RegExp(`^${CALLBACK_PREFIX}:(approve|deny):(\\d+)$`), async (ctx) => {
    try {
      const requestId = parseInt(ctx.match[2], 10);
      await ctx.answerCbQuery(RETIRED_ANSWER, { show_alert: true });

      const request = await ht.getHomeTimeRequestById(requestId).catch(() => null);
      const chatId = ctx.callbackQuery?.message?.chat?.id;
      const messageId = ctx.callbackQuery?.message?.message_id;
      if (!chatId || !messageId) return;

      // Rewrite the card without a keyboard, so the retired buttons are gone for
      // everyone rather than only for whoever pressed one.
      await ctx.telegram.editMessageText(
        chatId, messageId, undefined,
        buildRetiredCardText(request || { id: requestId }),
        { parse_mode: 'HTML', disable_web_page_preview: true }
      );
      console.log(`[HOME-TIME-REQ] Retired an old approval card for request #${requestId}.`);
    } catch (err) {
      // A card that cannot be edited (too old, already edited) is not a failure:
      // the person pressing it has already been told approval is not needed.
      console.warn('[HOME-TIME-REQ] Could not retire an old approval card:', err.message);
    }
  });

  console.log('[HOME-TIME-REQ] Legacy approval buttons retired (no new card carries them).');
}

module.exports = { registerHomeTimeRequestHandlers, RETIRED_ANSWER };
