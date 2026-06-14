function messageText(message) {
  if (!message || typeof message !== 'object') return null;
  if (typeof message.text === 'string') return message.text;
  if (typeof message.caption === 'string') return message.caption;
  return null;
}

function contentKind(message) {
  if (typeof message?.text === 'string') return 'text';
  if (typeof message?.caption === 'string') return 'caption';
  return 'other';
}

function messageSentAt(message) {
  if (!Number.isFinite(message?.date)) return null;
  return new Date(message.date * 1000).toISOString();
}

async function recordResult(db, method, payload, result) {
  if (Array.isArray(result)) {
    for (const item of result) {
      await recordResult(db, method, payload, item);
    }
    return;
  }

  if (!result || typeof result !== 'object' || result.message_id == null) return;
  const chatId = result.chat?.id ?? payload?.chat_id;
  if (chatId == null || typeof db.recordBotSentMessage !== 'function') return;

  await db.recordBotSentMessage({
    telegramChatId: String(chatId),
    telegramMessageId: String(result.message_id),
    sentAt: messageSentAt(result),
    messageText: messageText(result),
    contentKind: contentKind(result),
    sourceMethod: method,
  });
}

function shouldRecordMethod(method) {
  return /^(send|edit|copy|forward)/.test(String(method || ''));
}

function installBotSentMessageTracking(telegram, db, logger = console) {
  if (!telegram || typeof telegram.callApi !== 'function') return false;
  if (telegram.__wenzeSentMessageTrackingInstalled) return false;

  const originalCallApi = telegram.callApi.bind(telegram);
  telegram.callApi = async (method, payload, ...rest) => {
    const result = await originalCallApi(method, payload, ...rest);
    if (shouldRecordMethod(method)) {
      try {
        await recordResult(db, method, payload, result);
      } catch (err) {
        // Never turn a successful Telegram send into a retry and duplicate.
        logger.warn('[BOT-MESSAGE-REGISTRY] Failed to record sent message:', err.message);
      }
    }
    return result;
  };
  telegram.__wenzeSentMessageTrackingInstalled = true;
  return true;
}

function forwardMetadata(message) {
  const origin = message?.forward_origin || null;
  const legacyDate = Number.isFinite(message?.forward_date) ? message.forward_date : null;
  const forwardedAt = Number.isFinite(origin?.date) ? origin.date : legacyDate;

  let telegramChatId = null;
  let telegramMessageId = null;
  let senderUserId = null;

  if (origin?.type === 'channel') {
    telegramChatId = origin.chat?.id ?? null;
    telegramMessageId = origin.message_id ?? null;
  } else if (origin?.type === 'chat') {
    telegramChatId = origin.sender_chat?.id ?? null;
  } else if (origin?.type === 'user') {
    senderUserId = origin.sender_user?.id ?? null;
  }

  telegramChatId = message?.forward_from_chat?.id ?? telegramChatId;
  telegramMessageId = message?.forward_from_message_id ?? telegramMessageId;
  senderUserId = message?.forward_from?.id ?? senderUserId;

  return {
    isForwarded: Boolean(
      origin
      || message?.forward_from
      || message?.forward_from_chat
      || legacyDate
    ),
    telegramChatId: telegramChatId == null ? null : String(telegramChatId),
    telegramMessageId: telegramMessageId == null ? null : String(telegramMessageId),
    senderUserId: senderUserId == null ? null : String(senderUserId),
    sentAt: forwardedAt == null ? null : new Date(forwardedAt * 1000).toISOString(),
    messageText: messageText(message),
  };
}

async function resolveForwardedBotMessage(message, { db, botInfo } = {}) {
  const metadata = forwardMetadata(message);
  if (!metadata.isForwarded) return { status: 'not_forwarded' };

  const botId = botInfo?.id == null ? null : String(botInfo.id);
  if (metadata.senderUserId && botId && metadata.senderUserId !== botId) {
    return { status: 'not_this_bot' };
  }

  if (
    metadata.telegramChatId
    && metadata.telegramMessageId
    && typeof db.getBotSentMessage === 'function'
  ) {
    const direct = await db.getBotSentMessage(
      metadata.telegramChatId,
      metadata.telegramMessageId
    );
    if (!direct) return { status: 'untracked' };
    if (
      metadata.messageText != null
      && direct.message_text != null
      && metadata.messageText !== direct.message_text
    ) {
      return { status: 'content_mismatch' };
    }
    return { status: 'resolved', target: direct };
  }

  if (
    !metadata.sentAt
    || metadata.messageText == null
    || typeof db.findBotSentMessagesForForward !== 'function'
  ) {
    return { status: 'insufficient_metadata' };
  }

  const candidates = await db.findBotSentMessagesForForward({
    sentAt: metadata.sentAt,
    messageText: metadata.messageText,
    telegramChatId: metadata.telegramChatId,
  });
  if (candidates.length === 0) return { status: 'untracked' };
  if (candidates.length > 1) return { status: 'ambiguous' };
  return { status: 'resolved', target: candidates[0] };
}

module.exports = {
  contentKind,
  forwardMetadata,
  installBotSentMessageTracking,
  messageText,
  recordResult,
  resolveForwardedBotMessage,
};
