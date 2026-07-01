/**
 * Admin edit/delete of bot-sent messages by registry id.
 *
 * The admin panel lists every message the bot sent (from the bot_sent_messages
 * registry) and can edit or delete any of them even when there is no shareable
 * message link — we already have the (chat, message) pair on file.
 *
 * Both operations call Telegram first, then reflect the result in the registry
 * row, and always return a structured { ok, reason } so the API can surface a
 * Telegram-side failure instead of swallowing it. Error handling mirrors
 * mileageBonusService.removeTelegramCard(): a delete on a message that Telegram
 * says is already gone is treated as success (the goal state is reached), and a
 * message that can't be deleted falls back to stripping its inline buttons.
 */

function resolveDeps(deps = {}) {
  const database = deps.database || require('../database/db');
  const telegram = deps.telegram || require('../bot/bot').bot.telegram;
  return { database, telegram };
}

function describeError(err) {
  return String(err?.description || err?.message || err || '').toLowerCase();
}

/**
 * Edit the text of a bot-sent message in Telegram, then record the new text.
 * @returns {Promise<{ok: boolean, reason: string, error?: string, row?: object}>}
 */
async function editBotMessage(chatId, messageId, newText, deps = {}) {
  const { database, telegram } = resolveDeps(deps);

  if (chatId == null || messageId == null) {
    return { ok: false, reason: 'invalid_target', error: 'Missing chat or message id.' };
  }
  if (typeof newText !== 'string' || newText.trim() === '') {
    return { ok: false, reason: 'empty_text', error: 'Replacement text is required.' };
  }

  try {
    await telegram.editMessageText(String(chatId), Number(messageId), undefined, newText);
  } catch (err) {
    const desc = describeError(err);
    // Telegram returns this when the new text equals the old text. Nothing
    // changed on their side, but the admin intent still succeeded.
    if (desc.includes('message is not modified')) {
      const row = await database
        .markBotSentMessageEdited(String(chatId), String(messageId), newText)
        .catch(() => null);
      return { ok: true, reason: 'not_modified', row };
    }
    // Messages older than 48h, or service/media messages, cannot be edited.
    if (desc.includes("message can't be edited") || desc.includes('message can not be edited')) {
      return { ok: false, reason: 'not_editable', error: err.message || err.description };
    }
    if (desc.includes('message to edit not found')) {
      return { ok: false, reason: 'not_found', error: err.message || err.description };
    }
    if (desc.includes('there is no text in the message to edit')) {
      // Media message: edit its caption instead.
      try {
        await telegram.editMessageCaption(String(chatId), Number(messageId), undefined, newText);
        const row = await database.markBotSentMessageEdited(String(chatId), String(messageId), newText);
        return { ok: true, reason: 'edited_caption', row };
      } catch (captionErr) {
        return { ok: false, reason: 'telegram_error', error: captionErr.message || captionErr.description };
      }
    }
    return { ok: false, reason: 'telegram_error', error: err.message || err.description };
  }

  const row = await database.markBotSentMessageEdited(String(chatId), String(messageId), newText);
  return { ok: true, reason: 'edited', row };
}

/**
 * Delete a bot-sent message in Telegram, then mark the registry row deleted.
 * @returns {Promise<{ok: boolean, reason: string, error?: string, row?: object}>}
 */
async function deleteBotMessage(chatId, messageId, deps = {}) {
  const { database, telegram } = resolveDeps(deps);

  if (chatId == null || messageId == null) {
    return { ok: false, reason: 'invalid_target', error: 'Missing chat or message id.' };
  }

  try {
    await telegram.deleteMessage(String(chatId), Number(messageId));
  } catch (err) {
    const desc = describeError(err);
    // Already gone (deleted elsewhere, or expired): the goal state is reached,
    // so mark it deleted and report success.
    if (desc.includes('message to delete not found')) {
      const row = await database
        .markBotSentMessageDeleted(String(chatId), String(messageId))
        .catch(() => null);
      return { ok: true, reason: 'already_gone', row };
    }
    // Too old to delete (Telegram only lets bots delete recent messages) or
    // otherwise undeletable: fall back to stripping any inline buttons so it
    // can no longer be interacted with, like removeTelegramCard() does.
    if (desc.includes("message can't be deleted") || desc.includes('message can not be deleted')) {
      let buttonsRemoved = false;
      try {
        await telegram.editMessageReplyMarkup(
          String(chatId),
          Number(messageId),
          undefined,
          { inline_keyboard: [] }
        );
        buttonsRemoved = true;
      } catch (_editErr) {
        // Best effort only.
      }
      return {
        ok: false,
        reason: buttonsRemoved ? 'buttons_removed' : 'not_deletable',
        error: err.message || err.description,
      };
    }
    return { ok: false, reason: 'telegram_error', error: err.message || err.description };
  }

  const row = await database.markBotSentMessageDeleted(String(chatId), String(messageId));
  return { ok: true, reason: 'deleted', row };
}

module.exports = {
  editBotMessage,
  deleteBotMessage,
};
