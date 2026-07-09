/**
 * Outbound send family: survey questions, broadcasts, confirmation broadcasts,
 * and their management-group test previews — plus the shared media sender.
 *
 * Moved verbatim from bot/bot.js. Exposed as a factory so bot.js hands in its
 * Telegraf instance and the live db/config module objects (tests patch
 * properties on those objects, so they must be the same references).
 */
const { Markup } = require('telegraf');
const { isPermanentSendError } = require('../services/telegramHtml');
const { normalizeMediaItems } = require('../services/scheduledMessageUtils');
const {
  buildBroadcastTemplateContext,
  renderBroadcastTemplateStrict,
} = require('../services/broadcastTemplateService');
const { escapeHtml, getTranslation } = require('./utils/telegramFormatting');

// ─── Rate-limit sleep helper ───
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Pick localized message text; `forceLanguage` overrides per-group language when set. */
function pickBroadcastMessage(messages, messageText, group, forceLanguage) {
  const lang =
    forceLanguage && ['en', 'ru', 'uz'].includes(forceLanguage)
      ? forceLanguage
      : (group && group.language) || 'en';
  if (messages && typeof messages === 'object') {
    return messages[lang] || messages.en || messageText;
  }
  return messageText;
}

function effectiveLangForConfirmation(group, forceLanguage) {
  if (forceLanguage && ['en', 'ru', 'uz'].includes(forceLanguage)) return forceLanguage;
  return (group && group.language) || 'en';
}

function createBotSenders({ bot, db, config }) {
  const MANAGEMENT_GROUP_ID = config.managementGroupId;

  async function resolveRenderedBroadcastText({
    group,
    messageText,
    messages,
    forceLanguage,
    enablePlaceholders = true,
  }) {
    const rawText = pickBroadcastMessage(messages, messageText, group, forceLanguage);
    if (!enablePlaceholders) return rawText;

    const profile = await db.getDriverProfileByGroupId(group.id);
    const context = buildBroadcastTemplateContext({ profile, group });
    const rendered = renderBroadcastTemplateStrict(rawText, context);
    if (rendered.unknownTokens.length > 0) {
      const err = new Error(`Unknown placeholders: ${rendered.unknownTokens.map((t) => `{${t}}`).join(', ')}`);
      err.code = 'BROADCAST_UNKNOWN_PLACEHOLDER';
      err.unknownTokens = rendered.unknownTokens;
      throw err;
    }
    if (rendered.missingTokens.length > 0) {
      const err = new Error(`Missing placeholder values: ${rendered.missingTokens.map((t) => `{${t}}`).join(', ')}`);
      err.code = 'BROADCAST_PLACEHOLDER_MISSING';
      err.missingTokens = rendered.missingTokens;
      throw err;
    }

    return rendered.rendered;
  }

  /**
   * Send media to a chat.
   * - 1 item: sendPhoto/sendVideo (supports caption + inline keyboard buttons)
   * - 2-10 items: sendMediaGroup album (caption on first item only; no buttons on album)
   *
   * @param {string|number} chatId
   * @param {Array<{file_id, media_type}>} mediaItems
   * @param {string|null} caption
   * @param {string|null} parseMode  e.g. 'HTML'
   * @param {object|null} keyboard   Markup.inlineKeyboard(...) — only used for single-file
   */
  async function sendMedia(chatId, mediaItems, caption, parseMode, keyboard) {
    const normalizedMediaItems = normalizeMediaItems(mediaItems);
    if (!normalizedMediaItems.length) return;

    // Telegram limits captions to 1024 chars. If longer, send media without caption, then send text.
    let safeCaption = caption;
    let textToFollowUp = null;
    if (caption && caption.length > 1000) {
      safeCaption = null;
      textToFollowUp = caption;
    }

    if (normalizedMediaItems.length === 1) {
      // Single file
      const { file_id, media_type } = normalizedMediaItems[0];
      const opts = { ...(keyboard || {}) };
      if (safeCaption) {
        opts.caption = safeCaption;
        if (parseMode) opts.parse_mode = parseMode;
      }
      if (media_type === 'video') {
        await bot.telegram.sendVideo(chatId, file_id, opts);
      } else {
        await bot.telegram.sendPhoto(chatId, file_id, opts);
      }
    } else {
      // Multiple files (Album)
      const group = normalizedMediaItems.map((m, i) => ({
        type: m.media_type === 'video' ? 'video' : 'photo',
        media: m.file_id,
        ...(i === 0 && safeCaption ? { caption: safeCaption, parse_mode: parseMode } : {}),
      }));
      await bot.telegram.sendMediaGroup(chatId, group);
    }

    // If the caption was too long, send it as a standalone text message immediately after
    if (textToFollowUp) {
      await bot.telegram.sendMessage(chatId, textToFollowUp, {
        parse_mode: parseMode,
        ...(keyboard || {})
      });
    }
  }

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

  // ─── Send broadcast message to all driver groups (legacy helper) ───
  async function sendBroadcast(messageText, parseMode, messages, mediaItems, mediaPosition, broadcastId, forceLanguage) {
    const groups = await db.getAllDriverGroups();
    return sendBroadcastToGroups(
      groups,
      messageText,
      parseMode,
      messages,
      mediaItems,
      mediaPosition,
      broadcastId,
      forceLanguage
    );
  }

  // ─── Send broadcast test to management group ───
  async function sendBroadcastTest(messageText, parseMode, messages, mediaItems, mediaPosition, forceLanguage) {
    const fakeGroup = { language: 'en' };
    const text = pickBroadcastMessage(messages, messageText, fakeGroup, forceLanguage);
    const normalizedMediaItems = normalizeMediaItems(mediaItems);
    const hasMedia = normalizedMediaItems.length > 0;
    const position = mediaPosition || 'above';

    if (!hasMedia) {
      await bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, text, { parse_mode: parseMode });
    } else if (position === 'above') {
      await sendMedia(MANAGEMENT_GROUP_ID, normalizedMediaItems, text, parseMode, null);
    } else {
      await bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, text, { parse_mode: parseMode });
      await sendMedia(MANAGEMENT_GROUP_ID, normalizedMediaItems, null, null, null);
    }
    console.log('[BOT] Broadcast test sent to management group.');
  }

  // ─── Send broadcast to specific groups (used by scheduler + API) ───
  async function sendBroadcastToGroups(
    groups,
    messageText,
    parseMode,
    messages,
    mediaItems,
    mediaPosition,
    broadcastId,
    forceLanguage,
    options = {}
  ) {
    const results = { sent: 0, failed: 0, errors: [] };
    if (!groups || !Array.isArray(groups) || groups.length === 0) {
      console.warn('[BOT] sendBroadcastToGroups: no groups to send to');
      return results;
    }

    const normalizedMediaItems = normalizeMediaItems(mediaItems);
    const hasMedia = normalizedMediaItems.length > 0;
    const position = mediaPosition || 'above';
    const enablePlaceholders = options.enablePlaceholders !== false;

    for (const group of groups) {
      let success = false;
      let errorMsg = null;
      try {
        const text = await resolveRenderedBroadcastText({
          group,
          messageText,
          messages,
          forceLanguage,
          enablePlaceholders,
        });

        if (!hasMedia) {
          await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode });
        } else if (position === 'above') {
          await sendMedia(group.telegram_group_id, normalizedMediaItems, text, parseMode, null);
        } else {
          await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode });
          await sendMedia(group.telegram_group_id, normalizedMediaItems, null, null, null);
        }

        results.sent++;
        success = true;
        console.log(`[BOT] Broadcast sent to: ${group.group_name} (${group.telegram_group_id})`);
      } catch (err) {
        // Retry once on rate-limit (429)
        if (err.response && err.response.error_code === 429) {
          const retryAfter = (err.response.parameters && err.response.parameters.retry_after) || 5;
          console.warn(`[BOT] Rate limited on ${group.group_name}, retrying after ${retryAfter}s`);
          await sleep(retryAfter * 1000);
          try {
            const text = await resolveRenderedBroadcastText({
              group,
              messageText,
              messages,
              forceLanguage,
              enablePlaceholders,
            });
            if (!hasMedia) {
              await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode });
            } else if (position === 'above') {
              await sendMedia(group.telegram_group_id, normalizedMediaItems, text, parseMode, null);
            } else {
              await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode });
              await sendMedia(group.telegram_group_id, normalizedMediaItems, null, null, null);
            }
            results.sent++;
            success = true;
            console.log(`[BOT] Broadcast sent (retry) to: ${group.group_name}`);
          } catch (retryErr) {
            results.failed++;
            errorMsg = retryErr.message;
            results.errors.push({
              group: group.group_name,
              error: retryErr.message,
              ...(retryErr.missingTokens ? { missing_tokens: retryErr.missingTokens } : {}),
              ...(retryErr.unknownTokens ? { unknown_tokens: retryErr.unknownTokens } : {}),
            });
            console.error(`[BOT] Broadcast retry failed for ${group.group_name}:`, retryErr.message);
          }
        } else {
          results.failed++;
          errorMsg = err.message;
          results.errors.push({
            group: group.group_name,
            error: err.message,
            ...(err.missingTokens ? { missing_tokens: err.missingTokens } : {}),
            ...(err.unknownTokens ? { unknown_tokens: err.unknownTokens } : {}),
          });
          console.error(`[BOT] Broadcast failed for ${group.group_name}:`, err.message);
          if (isPermanentSendError(err)) {
            try { await db.deactivateGroup(group.telegram_group_id); } catch (_) {}
            console.warn(`[BOT] Auto-deactivated stale group: ${group.group_name} (${group.telegram_group_id})`);
          }
        }
      }

      // Record delivery if broadcastId provided
      if (broadcastId) {
        try {
          await db.createBroadcastDelivery({
            broadcast_id: broadcastId,
            group_id: group.id,
            telegram_group_id: group.telegram_group_id,
            group_name: group.group_name,
            status: success ? 'sent' : 'failed',
            error_message: errorMsg,
          });
        } catch (dbErr) {
          console.error('[BOT] Failed to record delivery:', dbErr.message);
        }
      }

      await sleep(50);
    }

    console.log(`[BOT] Targeted broadcast complete: ${results.sent} sent, ${results.failed} failed`);
    return results;
  }

  // ─── Send confirmation broadcast with inline buttons ───
  async function sendConfirmationBroadcast(
    messageText,
    parseMode,
    messages,
    mediaItems,
    mediaPosition,
    buttons,
    broadcastId,
    targetGroups,
    forceLanguage,
    options = {}
  ) {
    let groups;
    if (Array.isArray(targetGroups) && targetGroups.length > 0) {
      groups = targetGroups;
    } else {
      groups = await db.getAllDriverGroups();
    }

    const results = { sent: 0, failed: 0, errors: [] };
    if (!groups || groups.length === 0) {
      console.warn('[BOT] sendConfirmationBroadcast: no groups to send to');
      return results;
    }

    const normalizedMediaItems = normalizeMediaItems(mediaItems);
    const hasMedia = normalizedMediaItems.length > 0;
    const position = mediaPosition || 'above';
    const btnList = Array.isArray(buttons) ? buttons : [];
    const enablePlaceholders = options.enablePlaceholders !== false;

    for (const group of groups) {
      let success = false;
      let errorMsg = null;
      try {
        const text = await resolveRenderedBroadcastText({
          group,
          messageText,
          messages,
          forceLanguage,
          enablePlaceholders,
        });
        const lang = effectiveLangForConfirmation(group, forceLanguage);

        const keyboardRows = btnList.map((btn, i) => {
          const label = btn[`label_${lang}`] || btn.label_en || btn.label_ru || btn.label_uz || `Button ${i + 1}`;
          return [Markup.button.callback(label, `bcast_${broadcastId}_${i}`)];
        });
        const keyboard = Markup.inlineKeyboard(keyboardRows);

        if (!hasMedia) {
          await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode, ...keyboard });
        } else if (position === 'above') {
          if (normalizedMediaItems.length === 1) {
            await sendMedia(group.telegram_group_id, normalizedMediaItems, text, parseMode, keyboard);
          } else {
            await sendMedia(group.telegram_group_id, normalizedMediaItems, text, parseMode, null);
            await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode, ...keyboard });
          }
        } else {
          await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode, ...keyboard });
          await sendMedia(group.telegram_group_id, normalizedMediaItems, null, null, null);
        }

        results.sent++;
        success = true;
        console.log(`[BOT] Confirmation broadcast sent to: ${group.group_name} (${group.telegram_group_id})`);
      } catch (err) {
        if (err.response && err.response.error_code === 429) {
          const retryAfter = (err.response.parameters && err.response.parameters.retry_after) || 5;
          console.warn(`[BOT] Rate limited on ${group.group_name}, retrying after ${retryAfter}s`);
          await sleep(retryAfter * 1000);
          try {
            const text = await resolveRenderedBroadcastText({
              group,
              messageText,
              messages,
              forceLanguage,
              enablePlaceholders,
            });
            const lang = effectiveLangForConfirmation(group, forceLanguage);
            const keyboardRows = btnList.map((btn, i) => {
              const label = btn[`label_${lang}`] || btn.label_en || btn.label_ru || btn.label_uz || `Button ${i + 1}`;
              return [Markup.button.callback(label, `bcast_${broadcastId}_${i}`)];
            });
            const keyboard = Markup.inlineKeyboard(keyboardRows);
            if (!hasMedia) {
              await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode, ...keyboard });
            } else if (position === 'above') {
              if (normalizedMediaItems.length === 1) {
                await sendMedia(group.telegram_group_id, normalizedMediaItems, text, parseMode, keyboard);
              } else {
                await sendMedia(group.telegram_group_id, normalizedMediaItems, text, parseMode, null);
                await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode, ...keyboard });
              }
            } else {
              await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode, ...keyboard });
              await sendMedia(group.telegram_group_id, normalizedMediaItems, null, null, null);
            }
            results.sent++;
            success = true;
            console.log(`[BOT] Confirmation broadcast sent (retry) to: ${group.group_name}`);
          } catch (retryErr) {
            results.failed++;
            errorMsg = retryErr.message;
            results.errors.push({
              group: group.group_name,
              error: retryErr.message,
              ...(retryErr.missingTokens ? { missing_tokens: retryErr.missingTokens } : {}),
              ...(retryErr.unknownTokens ? { unknown_tokens: retryErr.unknownTokens } : {}),
            });
            console.error(`[BOT] Confirmation broadcast retry failed for ${group.group_name}:`, retryErr.message);
          }
        } else {
          results.failed++;
          errorMsg = err.message;
          results.errors.push({
            group: group.group_name,
            error: err.message,
            ...(err.missingTokens ? { missing_tokens: err.missingTokens } : {}),
            ...(err.unknownTokens ? { unknown_tokens: err.unknownTokens } : {}),
          });
          console.error(`[BOT] Confirmation broadcast failed for ${group.group_name}:`, err.message);
          if (isPermanentSendError(err)) {
            try { await db.deactivateGroup(group.telegram_group_id); } catch (_) {}
            console.warn(`[BOT] Auto-deactivated stale group: ${group.group_name} (${group.telegram_group_id})`);
          }
        }
      }

      if (broadcastId) {
        try {
          await db.createBroadcastDelivery({
            broadcast_id: broadcastId,
            group_id: group.id,
            telegram_group_id: group.telegram_group_id,
            group_name: group.group_name,
            status: success ? 'sent' : 'failed',
            error_message: errorMsg,
          });
        } catch (dbErr) {
          console.error('[BOT] Failed to record delivery:', dbErr.message);
        }
      }

      await sleep(50);
    }

    console.log(`[BOT] Confirmation broadcast complete: ${results.sent} sent, ${results.failed} failed`);
    return results;
  }

  // ─── Send confirmation broadcast test to management group ───
  async function sendConfirmationBroadcastTest(
    messageText,
    parseMode,
    messages,
    mediaItems,
    mediaPosition,
    buttons,
    forceLanguage
  ) {
    const fakeGroup = { language: 'en' };
    const text = pickBroadcastMessage(messages, messageText, fakeGroup, forceLanguage);
    const lang = effectiveLangForConfirmation(fakeGroup, forceLanguage);
    const btnList = Array.isArray(buttons) ? buttons : [];

    const normalizedMediaItems = normalizeMediaItems(mediaItems);
    const hasMedia = normalizedMediaItems.length > 0;
    const position = mediaPosition || 'above';

    const keyboardRows = btnList.map((btn, i) => {
      const label = btn[`label_${lang}`] || btn.label_en || `Button ${i + 1}`;
      return [Markup.button.callback(label, `test_bcast_${i}`)];
    });
    const keyboard = Markup.inlineKeyboard(keyboardRows);

    if (!hasMedia) {
      await bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, text, { parse_mode: parseMode, ...keyboard });
    } else if (position === 'above') {
      if (normalizedMediaItems.length === 1) {
        await sendMedia(MANAGEMENT_GROUP_ID, normalizedMediaItems, text, parseMode, keyboard);
      } else {
        await sendMedia(MANAGEMENT_GROUP_ID, normalizedMediaItems, text, parseMode, null);
        await bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, text, { parse_mode: parseMode, ...keyboard });
      }
    } else {
      await bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, text, { parse_mode: parseMode, ...keyboard });
      await sendMedia(MANAGEMENT_GROUP_ID, normalizedMediaItems, null, null, null);
    }
    console.log('[BOT] Confirmation broadcast test sent to management group.');
  }

  return {
    sendMedia,
    sendQuestionToGroups,
    sendTestQuestion,
    sendBroadcast,
    sendBroadcastTest,
    sendBroadcastToGroups,
    sendConfirmationBroadcast,
    sendConfirmationBroadcastTest,
  };
}

module.exports = { createBotSenders, pickBroadcastMessage, effectiveLangForConfirmation };
