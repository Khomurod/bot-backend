/**
 * Sending SURVEY QUESTIONS to driver groups, and the management-group preview.
 *
 * One question fans out to every active driver group in its own language, with
 * the inline answer keyboard. A permanent send error (the bot was removed from a
 * group) deactivates that group rather than retrying forever; a transient one
 * backs off.
 *
 * Split out of bot/senders.js.
 */

const { Markup } = require('telegraf');
const { isPermanentSendError } = require('../../services/telegramHtml');
const { normalizeMediaItems } = require('../../services/scheduledMessageUtils');
const {
  buildBroadcastTemplateContext,
  renderBroadcastTemplateStrict,
} = require('../../services/broadcastTemplateService');
const { escapeHtml, getTranslation } = require('../utils/telegramFormatting');
const { pickBroadcastMessage, effectiveLangForConfirmation } = require('./messageText');

// ─── Rate-limit sleep helper ───
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createQuestionSenders({ bot, db, config, sendMedia }) {
  const MANAGEMENT_GROUP_ID = config.managementGroupId;

  // ─── Send question to all groups ───
  async function sendQuestionToGroups(questionId) {
    const question = await db.getQuestionWithOptions(questionId);
    if (!question) throw new Error(`Question not found: ${questionId}`);

    const groups = await db.getAllGroups();
    const results = { sent: 0, failed: 0, errors: [] };

    const mediaItems = normalizeMediaItems(question.media_items || []);
    const hasMedia = mediaItems.length > 0;
    const mediaPosition = question.media_position || 'above';
    const isAlbum = mediaItems.length > 1;

    for (const group of groups) {
      try {
        const lang = group.language || 'en';
        const qTranslation = getTranslation(question.translations, lang);
        const questionText = qTranslation ? qTranslation.question_text : 'Question';

        const buttons = [];
        if (question.options) {
          for (const opt of question.options) {
            const oTranslation = getTranslation(opt.translations, lang);
            const optionText = oTranslation ? oTranslation.option_text : `Option ${opt.option_order}`;
            buttons.push([Markup.button.callback(optionText, `answer_${questionId}_${opt.id}`)]);
          }
        }

        const messageText = `📋 ${questionText}`;
        const keyboard = Markup.inlineKeyboard(buttons);

        if (!hasMedia) {
          // ── No media ──
          await bot.telegram.sendMessage(group.telegram_group_id, messageText, keyboard);
        } else if (mediaPosition === 'above') {
          if (isAlbum) {
            // ── Album above: send album (caption on first), then text + buttons ──
            await sendMedia(group.telegram_group_id, mediaItems, messageText, 'HTML', null);
            await bot.telegram.sendMessage(group.telegram_group_id, messageText, keyboard);
          } else {
            // ── Single media above: send with caption + buttons ──
            await sendMedia(group.telegram_group_id, mediaItems, messageText, 'HTML', keyboard);
          }
        } else {
          // ── Media below: text + buttons first, then media ──
          await bot.telegram.sendMessage(group.telegram_group_id, messageText, keyboard);
          await sendMedia(group.telegram_group_id, mediaItems, null, null, null);
        }

        results.sent++;
        console.log(`[BOT] Question sent to group: ${group.group_name} (${group.telegram_group_id}) in ${lang}`);
      } catch (err) {
        // Retry once on rate-limit (429)
        if (err.response && err.response.error_code === 429) {
          const retryAfter = (err.response.parameters && err.response.parameters.retry_after) || 5;
          console.warn(`[BOT] Rate limited on ${group.group_name}, retrying after ${retryAfter}s`);
          await sleep(retryAfter * 1000);
          try {
            const lang = group.language || 'en';
            const qTranslation = getTranslation(question.translations, lang);
            const questionText = qTranslation ? qTranslation.question_text : 'Question';
            const btns = [];
            if (question.options) {
              for (const opt of question.options) {
                const oTranslation = getTranslation(opt.translations, lang);
                const optionText = oTranslation ? oTranslation.option_text : `Option ${opt.option_order}`;
                btns.push([Markup.button.callback(optionText, `answer_${questionId}_${opt.id}`)]);
              }
            }
            const messageText = `📋 ${questionText}`;
            const keyboard = Markup.inlineKeyboard(btns);
            if (!hasMedia) {
              await bot.telegram.sendMessage(group.telegram_group_id, messageText, keyboard);
            } else if (mediaPosition === 'above') {
              if (isAlbum) {
                await sendMedia(group.telegram_group_id, mediaItems, messageText, 'HTML', null);
                await bot.telegram.sendMessage(group.telegram_group_id, messageText, keyboard);
              } else {
                await sendMedia(group.telegram_group_id, mediaItems, messageText, 'HTML', keyboard);
              }
            } else {
              await bot.telegram.sendMessage(group.telegram_group_id, messageText, keyboard);
              await sendMedia(group.telegram_group_id, mediaItems, null, null, null);
            }
            results.sent++;
            console.log(`[BOT] Question sent (retry) to group: ${group.group_name}`);
          } catch (retryErr) {
            results.failed++;
            results.errors.push({ group: group.group_name, error: retryErr.message });
            console.error(`[BOT] Retry failed for ${group.group_name}:`, retryErr.message);
          }
        } else {
          results.failed++;
          results.errors.push({ group: group.group_name, error: err.message });
          console.error(`[BOT] Failed to send to group ${group.group_name}:`, err.message);
          // Auto-deactivate groups where the bot was kicked/group deleted
          if (isPermanentSendError(err)) {
            try { await db.deactivateGroup(group.telegram_group_id); } catch (_) {}
            console.warn(`[BOT] Auto-deactivated stale group: ${group.group_name} (${group.telegram_group_id})`);
          }
        }
      }
      await sleep(50);
    }

    return results;
  }

  // ─── Send test question to management group ───
  async function sendTestQuestion(questionEn, optionsEn, mediaItems, mediaPosition) {
    const buttons = optionsEn.map((text, i) => [
      Markup.button.callback(text, `test_answer_${i + 1}`),
    ]);

    const message = `🧪 <b>TEST QUESTION PREVIEW</b>\n\n${escapeHtml(questionEn)}\n\n<i>Choose an option:</i>`;
    const keyboard = Markup.inlineKeyboard(buttons);
    const normalizedMediaItems = normalizeMediaItems(mediaItems);
    const hasMedia = normalizedMediaItems.length > 0;
    const isAlbum = normalizedMediaItems.length > 1;
    const position = mediaPosition || 'above';

    if (!hasMedia) {
      await bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, message, { parse_mode: 'HTML', ...keyboard });
    } else if (position === 'above') {
      if (isAlbum) {
        await sendMedia(MANAGEMENT_GROUP_ID, normalizedMediaItems, message, 'HTML', null);
        await bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, message, { parse_mode: 'HTML', ...keyboard });
      } else {
        await sendMedia(MANAGEMENT_GROUP_ID, normalizedMediaItems, message, 'HTML', keyboard);
      }
    } else {
      await bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, message, { parse_mode: 'HTML', ...keyboard });
      await sendMedia(MANAGEMENT_GROUP_ID, normalizedMediaItems, null, null, null);
    }

    console.log('[BOT] Test question sent to management group.');
  }

  return {
    sendQuestionToGroups,
    sendTestQuestion,
  };
}

module.exports = { createQuestionSenders };
