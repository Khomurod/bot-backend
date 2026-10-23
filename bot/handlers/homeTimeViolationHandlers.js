'use strict';

/**
 * Accounting's answer to a home-time violation alert.
 *
 *   ✅ Charged       — recorded, the alert says who and when, the buttons go.
 *   ❌ Not charging  — recorded at once (so nobody else can answer it), then
 *                      the presser is asked, in a reply, why; their reply is
 *                      written into the alert.
 *
 * ONLY ACCOUNTING may press (`isAccountingUser`, the same allow-list as the
 * mileage bonus cards); anyone else is told so and nothing changes. A decision
 * is written once — the UPDATE is conditional — so a double tap or a second
 * accountant cannot overwrite it. See docs/architecture/home-time-violation-alerts.md.
 */

const V = require('../../lib/homeTime/violations');
const store = require('../../database/homeTime/violationNotices');
const { isAccountingUser, ACCOUNTING_MENTIONS } = require('../../services/mileageBonusConstants');
const { safeSend } = require('../../services/telegramHtml');
const { recordAccountingReason } = require('../../services/ai/learning/accountingReasons');

const SETTINGS_TTL_MS = 60 * 1000;
let cachedChat = { id: null, at: 0 };

/** The configured alert group, read at most once a minute: every reply in every group passes the gate below. */
async function violationChatId(now = Date.now()) {
  if (now - cachedChat.at < SETTINGS_TTL_MS) return cachedChat.id;
  const settings = await store.getViolationSettings().catch(() => null);
  cachedChat = { id: settings?.violation_alerts_chat_id ? String(settings.violation_alerts_chat_id) : null, at: now };
  return cachedChat.id;
}

/** "@username", or the person's name when they have none — never a made-up handle. */
function nameOf(from) {
  if (from?.username) return `@${from.username}`;
  return [from?.first_name, from?.last_name].filter(Boolean).join(' ') || String(from?.id || '');
}

/** The alert as posted, with accounting's answer under it. */
function decidedText(rows) {
  const first = rows[0];
  return V.buildViolationMessage({
    driverName: first.driver_name,
    violations: rows.map((r) => r.violation),
    roadDays: first.road_days,
    homeDays: first.home_days,
    homeFrom: first.home_from,
    mentions: ACCOUNTING_MENTIONS,
  }) + V.decisionFooter({
    decision: first.decision,
    decidedByName: first.decided_by_name,
    decidedAt: first.decided_at,
    reason: first.decision_reason,
  });
}

async function onButton(ctx) {
  const decision = ctx.match[1] === 'c' ? 'charged' : 'not_charging';
  const from = ctx.from || {};
  const chatId = ctx.callbackQuery?.message?.chat?.id;
  const messageId = ctx.callbackQuery?.message?.message_id;
  try {
    if (!isAccountingUser(from)) {
      await ctx.answerCbQuery('Only accounting can mark this alert.', { show_alert: true });
      return;
    }
    const { rows, alreadyDecided } = await store.decide({
      chatId, messageId, decision, byId: from.id, byName: nameOf(from),
    });
    if (!rows.length) {
      await ctx.answerCbQuery('This alert is no longer available.');
      return;
    }
    if (alreadyDecided) {
      const first = rows[0];
      const what = first.decision === 'charged' ? 'charged' : 'not charging';
      await ctx.answerCbQuery(`Already marked ${what} by ${first.decided_by_name || 'accounting'}.`);
      return;
    }
    try {
      await ctx.editMessageText(decidedText(rows), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    } catch (err) {
      console.warn('[HOME-TIME-VIOLATION] could not edit the alert:', err.message);
    }
    await ctx.answerCbQuery(decision === 'charged' ? '✅ Marked as charged.' : '❌ Marked as not charging.');
    if (decision === 'not_charging') {
      const prompt = await safeSend(() => ctx.telegram.sendMessage(chatId, V.reasonPrompt(nameOf(from)), {
        parse_mode: 'HTML',
        reply_to_message_id: messageId,
        allow_sending_without_reply: true,
        reply_markup: { force_reply: true, selective: true },
      }));
      if (prompt?.message_id) await store.setReasonPrompt({ chatId, messageId, promptMessageId: prompt.message_id });
    }
    console.log(`[HOME-TIME-VIOLATION] deal ${rows[0].deal_id} marked ${decision} by ${nameOf(from)}`);
  } catch (err) {
    console.error('[HOME-TIME-VIOLATION] button error:', err.message);
    try { await ctx.answerCbQuery('Something went wrong — please try again.'); } catch (_) { /* expired */ }
  }
}

/** A reply to the "why not?" prompt, from the person who pressed. Anything else passes through. */
async function onReply(ctx, next) {
  const msg = ctx.message;
  if (!msg || !msg.reply_to_message || !msg.text) return next();
  let handled = false;
  try {
    const chatId = await violationChatId();
    if (chatId && String(ctx.chat?.id) === chatId) {
      const rows = await store.recordReason({
        chatId, promptMessageId: msg.reply_to_message.message_id, byId: ctx.from?.id, reason: msg.text.trim(),
      });
      if (rows.length) {
        handled = true;
        await ctx.telegram.editMessageText(chatId, rows[0].telegram_message_id, undefined, decidedText(rows), {
          parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        }).catch((err) => console.warn('[HOME-TIME-VIOLATION] could not add the reason:', err.message));
        // The owner, 23 October 2026: learn from why accounting did not charge.
        await recordAccountingReason(rows, msg.text.trim(), { name: nameOf(ctx.from || {}), telegramUserId: ctx.from?.id });
      }
    }
  } catch (err) {
    console.warn('[HOME-TIME-VIOLATION] reply error:', err.message);
  }
  return handled ? undefined : next();
}

function registerHomeTimeViolationHandlers(bot) {
  bot.action(V.CALLBACK_PATTERN, onButton);
  bot.on('message', onReply);
}

module.exports = {
  registerHomeTimeViolationHandlers,
  __test: {
    onButton, onReply, decidedText, resetCache: () => { cachedChat = { id: null, at: 0 }; },
  },
};
