/**
 * Survey + broadcast button callbacks:
 *   - bcast_{id}_{index}: confirmation-broadcast button clicks (recorded once);
 *   - test_bcast_ / test_answer_: test previews (never recorded);
 *   - the callback_query catch-all handling answer_{questionId}_{optionId}
 *     survey responses, which also reports each answer to management.
 *
 * Moved verbatim from bot/bot.js. bot.js registers this LAST among callback
 * handlers so the feature-specific action handlers (route control, mileage
 * bonus…) match first and are never swallowed.
 */
const config = require('../../config/config');
const db = require('../../database/db');
const { safeSend } = require('../../services/telegramHtml');
const { buildMention } = require('../../services/telegramMention');
const { escapeHtml, getTranslation } = require('../utils/telegramFormatting');

const MANAGEMENT_GROUP_ID = config.managementGroupId;

// ─── Report to management group ───
async function reportToManagement(bot, driver, group, questionId, optionId) {
  try {
    const question = await db.getQuestionWithOptions(questionId);
    if (!question) return;

    const englishQ = getTranslation(question.translations, 'en');
    const questionText = englishQ ? englishQ.question_text : 'Unknown question';

    let optionText = 'Unknown answer';
    if (question.options) {
      for (const opt of question.options) {
        if (opt.id === optionId) {
          const englishO = getTranslation(opt.translations, 'en');
          optionText = englishO ? englishO.option_text : 'Unknown answer';
          break;
        }
      }
    }

    // Prefer @username; otherwise a tg://user?id inline mention so the driver
    // is still tagged (we have their captured id on the drivers row here).
    const driverHandle = buildMention(driver, { fallbackName: 'Driver' });

    const message = `📋 <b>Driver Feedback</b>\n\n` +
      `<b>Group:</b> ${escapeHtml(group.group_name)}\n` +
      `<b>Driver:</b> ${driverHandle}\n\n` +
      `<b>Question:</b>\n${escapeHtml(questionText)}\n\n` +
      `<b>Answer:</b>\n${escapeHtml(optionText)}`;

    await safeSend(
      () => bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, message, { parse_mode: 'HTML' }),
      { maxAttempts: 4, baseDelayMs: 750 }
    );

    console.log(`[BOT] Report sent to management for driver=${driverHandle}`);
  } catch (err) {
    // safeSend already retried with exponential backoff + 429 awareness,
    // so by the time we get here the failure is effectively permanent.
    console.error('[BOT] Error reporting to management (after retries):', err.message);
  }
}

function registerSurveyCallbackHandlers(bot) {
  // ── Handler: confirmation broadcast button clicks ──
  bot.action(/^bcast_(\d+)_(\d+)$/, async (ctx) => {
    try {
      const match = ctx.match;
      const broadcastId = parseInt(match[1], 10);
      const buttonIndex = parseInt(match[2], 10);
      const from = ctx.from;
      const chat = ctx.callbackQuery?.message?.chat;

      const result = await db.saveBroadcastButtonClick({
        broadcast_id: broadcastId,
        button_index: buttonIndex,
        button_label: null, // label not stored in callback data
        driver_telegram_id: from.id,
        driver_username: from.username || null,
        driver_first_name: from.first_name || null,
        driver_last_name: from.last_name || null,
        group_telegram_id: chat?.id || null,
        group_name: chat?.title || null,
      });

      if (!result) {
        await ctx.answerCbQuery('You have already responded.');
      } else {
        await ctx.answerCbQuery('✅ Response recorded!');
        console.log(`[BOT] Broadcast button click: broadcast=${broadcastId}, button=${buttonIndex}, driver=${from.id}`);
      }
    } catch (err) {
      console.error('[BOT] Error handling bcast callback:', err.message);
      try { await ctx.answerCbQuery('An error occurred.'); } catch (err) { console.warn('[BOT] Failed to answer callback query:', err.message); }
    }
  });

  // ── Handler: test broadcast button clicks (no tracking) ──
  bot.action(/^test_bcast_/, async (ctx) => {
    await ctx.answerCbQuery('This is a test preview. Responses are not recorded.');
  });

  // ── 3. Handle TEST callback queries (test preview buttons) ──
  bot.on('callback_query', async (ctx) => {
    try {
      const data = ctx.callbackQuery.data;

      // Handle test preview buttons
      if (data && data.startsWith('test_answer_')) {
        await ctx.answerCbQuery('This is a test preview. Responses are not recorded.');
        return;
      }

      if (!data || !data.startsWith('answer_')) {
        // Unknown callback data — acknowledge to clear Telegram UI spinner
        try { await ctx.answerCbQuery(); } catch (err) { console.warn('[BOT] Failed to answer callback query:', err.message); }
        return;
      }

      const parts = data.split('_');
      // format: answer_{questionId}_{optionId}
      if (parts.length !== 3) return;

      const questionId = parseInt(parts[1], 10);
      const optionId = parseInt(parts[2], 10);

      if (isNaN(questionId) || isNaN(optionId)) return;

      // Get or register driver
      const driver = await db.upsertDriver(
        ctx.from.id,
        ctx.from.username || null,
        ctx.from.first_name || null,
        ctx.from.last_name || null
      );

      // Get group
      const chatId = ctx.callbackQuery.message?.chat?.id;
      let group = null;
      if (chatId) {
        group = await db.getGroupByTelegramId(chatId);
        if (!group) {
          // Auto-register group if not exists
          const chatTitle = ctx.callbackQuery.message?.chat?.title || 'Unknown';
          group = await db.upsertGroup(chatId, chatTitle);
        }
      }

      if (!driver || !group) {
        await ctx.answerCbQuery('Error processing your response.');
        return;
      }

      // Save response (duplicate-safe)
      const response = await db.saveResponse(
        driver.id,
        group.id,
        questionId,
        optionId
      );

      if (!response) {
        await ctx.answerCbQuery('You have already answered this question.');
        return;
      }

      await ctx.answerCbQuery('Thank you for your feedback!');
      console.log(`[BOT] Answer received: driver=${driver.telegram_user_id}, question=${questionId}, option=${optionId}`);

      // ── 4. Report to management group ──
      await reportToManagement(bot, driver, group, questionId, optionId);
    } catch (err) {
      console.error('[BOT] Error handling callback:', err.message);
      try {
        await ctx.answerCbQuery('An error occurred. Please try again.');
      } catch (err) { console.warn('[BOT] Failed to answer callback query:', err.message); }
    }
  });
}

module.exports = { registerSurveyCallbackHandlers };
