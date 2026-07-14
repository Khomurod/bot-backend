/**
 * Server-side validation of a BOL/POD central Telegram group.
 *
 * Confirms, without ever exposing the bot token, that a configured central group
 * id is well-formed, reachable, of a supported chat type, and that the bot can
 * post documents there. Also sends a harmless test message. All functions return
 * a plain result object ({ ok, ... }) and never throw token/internal details.
 */

// Groups/supergroups/channels are valid document destinations; a private ('private')
// user chat is not a group and is rejected.
const VALID_CHAT_TYPES = new Set(['group', 'supergroup', 'channel']);

/** Canonical numeric chat id, or null when not a valid Telegram chat id. */
function normalizeChatId(raw) {
  const str = String(raw ?? '').trim();
  if (!/^-?\d{1,20}$/.test(str)) return null;
  return str;
}

/** Strip any accidental bot-token-looking substring from an error message. */
function cleanTelegramError(err) {
  const desc = err?.response?.description || err?.description || err?.message || 'unknown error';
  return String(desc).replace(/bot\d+:[A-Za-z0-9_-]+/gi, 'bot***').slice(0, 300);
}

async function getBotId(telegram) {
  const me = await telegram.getMe();
  return me?.id ?? null;
}

/**
 * Validate a central group. Checks: id format → chat exists & is a
 * group/supergroup/channel → the bot is a member permitted to send documents.
 * @returns {Promise<{ok:boolean, title?:string|null, chatType?:string,
 *   memberStatus?:string|null, reason?:string, message:string}>}
 */
async function validateGroup(telegram, groupId) {
  const chatId = normalizeChatId(groupId);
  if (!chatId) {
    return {
      ok: false,
      reason: 'invalid_format',
      message: 'Enter a valid numeric Telegram chat id (e.g. -1002997837889).',
    };
  }

  let chat;
  try {
    chat = await telegram.getChat(chatId);
  } catch (err) {
    return {
      ok: false,
      reason: 'not_found',
      message: `The bot cannot access this chat: ${cleanTelegramError(err)}`,
    };
  }

  if (!VALID_CHAT_TYPES.has(chat?.type)) {
    return {
      ok: false,
      reason: 'wrong_type',
      title: chat?.title || null,
      message: `This is a "${chat?.type || 'private'}" chat, not a group or channel. `
        + 'Use a group, supergroup, or channel the bot belongs to.',
    };
  }

  try {
    const botId = await getBotId(telegram);
    const member = await telegram.getChatMember(chatId, botId);
    const memberStatus = member?.status || null;

    if (memberStatus === 'left' || memberStatus === 'kicked') {
      return {
        ok: false,
        reason: 'not_member',
        title: chat.title || null,
        message: 'Add the bot to this group before enabling forwarding.',
      };
    }
    if (memberStatus === 'restricted') {
      const canPost = member.can_send_documents !== false && member.can_send_media_messages !== false;
      if (!canPost) {
        return {
          ok: false,
          reason: 'cannot_post',
          title: chat.title || null,
          message: 'The bot is restricted and cannot send documents in this group.',
        };
      }
    }
    // A channel requires the bot to be an administrator to post at all.
    if (chat.type === 'channel' && !['administrator', 'creator'].includes(memberStatus)) {
      return {
        ok: false,
        reason: 'cannot_post',
        title: chat.title || null,
        message: 'For a channel the bot must be an administrator to post documents.',
      };
    }

    return {
      ok: true,
      title: chat.title || null,
      chatType: chat.type,
      memberStatus,
      message: `Validated "${chat.title || chatId}". The bot can post documents here.`,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'member_check_failed',
      title: chat.title || null,
      message: `Could not confirm the bot's membership: ${cleanTelegramError(err)}`,
    };
  }
}

/** Send a harmless text test message to the given group. */
async function sendTestMessage(telegram, groupId) {
  const chatId = normalizeChatId(groupId);
  if (!chatId) {
    return { ok: false, message: 'Enter a valid numeric Telegram chat id first.' };
  }
  try {
    const sent = await telegram.sendMessage(chatId, '✅ BOL/POD forwarding test successful');
    return { ok: true, messageId: sent?.message_id || null, message: 'Test message sent.' };
  } catch (err) {
    return { ok: false, message: `Failed to send test message: ${cleanTelegramError(err)}` };
  }
}

module.exports = {
  validateGroup,
  sendTestMessage,
  normalizeChatId,
  VALID_CHAT_TYPES,
};
