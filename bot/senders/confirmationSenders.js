/**
 * Sending CONFIRMATION broadcasts — a broadcast that asks for a tap back.
 *
 * Same fan-out as a plain broadcast plus an inline acknowledge button, and the
 * per-group recipient rows the acknowledgement is later matched against. Those
 * rows are what let the admin panel show who has and has not confirmed.
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

function createConfirmationSenders({ bot, db, config, sendMedia, resolveRenderedBroadcastText }) {
  const MANAGEMENT_GROUP_ID = config.managementGroupId;

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
    sendConfirmationBroadcast,
    sendConfirmationBroadcastTest,
  };
}

module.exports = { createConfirmationSenders };
