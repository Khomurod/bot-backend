/**
 * The shared MEDIA sender, and strict broadcast-template rendering.
 *
 * Every outbound family below sends its photos/videos through sendMedia, so
 * album grouping, caption placement and the rate-limit sleep live in exactly
 * one place. Media is sent by stored Telegram file_id where possible — the
 * staging chat gives us one — rather than re-uploading bytes from Render.
 *
 * `resolveRenderedBroadcastText` renders a template STRICTLY: an unresolved
 * placeholder is an error rather than a message with "{{name}}" in it.
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

function createMediaSender({ bot, db, config }) {
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

  return {
    resolveRenderedBroadcastText,
    sendMedia,
  };
}

module.exports = { createMediaSender };
