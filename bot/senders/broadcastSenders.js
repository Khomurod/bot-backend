/**
 * Sending BROADCASTS: to every driver group, to a chosen subset, or as a
 * management-group test.
 *
 * `sendBroadcastToGroups` is the one the scheduler and the admin API both use,
 * so its per-group error handling is what decides whether a group is
 * deactivated or retried. Delivery is recorded per group, which is what makes a
 * partially-failed broadcast resumable rather than re-sent to everyone.
 *
 * Split out of bot/senders.js.
 */

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

function createBroadcastSenders({ bot, db, config, sendMedia, resolveRenderedBroadcastText }) {
  const MANAGEMENT_GROUP_ID = config.managementGroupId;

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

  return {
    sendBroadcast,
    sendBroadcastTest,
    sendBroadcastToGroups,
  };
}

module.exports = { createBroadcastSenders };
