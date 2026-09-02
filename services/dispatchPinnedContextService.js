/**
 * Dispatch pinned load context — the readers and their fallback ORDER.
 *
 * Answers "what load is this driver on?" for the dispatch status hub. The ORDER
 * of the fallbacks is the contract, which is why they stay together in one
 * readable file: the pinned rate confirmation first, then a recent stored load,
 * then a load-like chat message, then Datatruck. Each source is less
 * authoritative than the one before it, and the first COMPLETE answer wins.
 *
 * What each step composes lives in focused modules:
 *
 *   ./pinnedContext/constants.js           interactive timeouts + byte caps
 *   ./pinnedContext/rules.js               PURE trust/completeness/merge rules
 *   ./pinnedContext/pinnedSource.js        the pinned message and its file
 *   ./pinnedContext/aiExtraction.js        the Groq/Gemini reads of a rate con
 *   ./pinnedContext/loadContextFromText.js raw text -> merged load context
 *
 * Saying nothing beats guessing: a weak destination is rejected rather than
 * routed on, because the answer is read out to a driver.
 */
const { extractRateConRawTextFromFile } = require('../server/services/dispatchParserService');
const { pickStoredLoadForContext } = require('./recentLoadSelection');
const { isLoadLikeChatMessage } = require('./loadTextPatterns');
const datatruckLoadService = require('./datatruckLoadService');
const {
  CHAT_HISTORY_LOOKBACK_DAYS, NO_CURRENT_LOAD_INFO_MESSAGE,
  truncateDispatchEtaLogMessage,
} = require('./pinnedContext/constants');
const {
  normalizeLine, isLikelyStaleStatusMessage, isLoadContextComplete,
  inferDestinationFromPinnedText, choosePinnedMessageCandidate, safeParseJsonObject,
} = require('./pinnedContext/rules');
const {
  getPinnedSnapshotFromDb, getPinnedFileDescriptor, buildPinnedSignature,
  downloadTelegramFileBuffer,
} = require('./pinnedContext/pinnedSource');
const { buildLoadContextFromText } = require('./pinnedContext/loadContextFromText');

async function getLatestLoadLikeChatMessageFromHistory(groupId, daysBack = CHAT_HISTORY_LOOKBACK_DAYS) {
  if (!groupId) return null;
  const db = require('../database/db');
  const logs = await db.getChatLogsForGroup(groupId, daysBack);
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const row = logs[index];
    const text = String(row?.message_text || '').trim();
    if (!isLoadLikeChatMessage(text)) continue;
    if (isLikelyStaleStatusMessage(text)) continue;
    return {
      messageText: text,
      createdAt: row?.created_at || null,
      senderName: row?.sender_name || '',
      messageId: row?.telegram_message_id || null,
    };
  }
  return null;
}

async function readPinnedLoadContext({
  telegram,
  chatId,
  groupId = null,
  previousSignature = '',
  cachedDestinationQuery = '',
  cachedPickup = '',
  cachedDelivery = '',
  interactive = false,
}) {
  const chat = await telegram.getChat(chatId);
  const snapshot = await getPinnedSnapshotFromDb(groupId);
  const pinnedMessage = choosePinnedMessageCandidate({
    chatPinnedMessage: chat?.pinned_message || null,
    snapshotPinnedMessage: snapshot?.pinned_message_json || null,
    snapshotSourceEventAt: snapshot?.source_event_at || null,
  });
  if (!pinnedMessage) {
    const err = new Error('No pinned message found in this group.');
    err.code = 'PINNED_MESSAGE_NOT_FOUND';
    throw err;
  }

  const pinnedText = [pinnedMessage.text, pinnedMessage.caption]
    .filter(Boolean)
    .join('\n')
    .trim();
  const fileDescriptor = getPinnedFileDescriptor(pinnedMessage);
  const pinnedSignature = buildPinnedSignature({
    pinnedMessage,
    text: pinnedText,
    fileDescriptor,
  });

  if (
    previousSignature
    && previousSignature === pinnedSignature
    && normalizeLine(cachedDestinationQuery)
  ) {
    return {
      pinnedMessageId: pinnedMessage.message_id || null,
      pinnedSignature,
      pickupSummary: normalizeLine(cachedPickup),
      deliverySummary: normalizeLine(cachedDelivery),
      destinationQuery: normalizeLine(cachedDestinationQuery),
      source: 'cache',
      pinnedText,
      aiModel: '',
      extractedRawText: '',
      loadInfoComplete: true,
    };
  }

  let sourceFile = null;
  let extractedRawText = '';
  if (fileDescriptor?.fileId) {
    try {
      const buffer = await downloadTelegramFileBuffer(telegram, fileDescriptor.fileId);
      sourceFile = {
        originalname: fileDescriptor.filename,
        mimetype: fileDescriptor.mimeType,
        buffer,
      };
      const extracted = await extractRateConRawTextFromFile(sourceFile);
      extractedRawText = String(extracted?.text || '').trim();
    } catch (err) {
      sourceFile = null;
      extractedRawText = '';
      console.warn('[DISPATCH-ETA] Pinned media extraction failed:', err.message);
    }
  }

  const parsedContext = await buildLoadContextFromText({
    pinnedText,
    extractedRawText,
    sourceFile,
    sourceLabel: fileDescriptor ? 'pinned-text+media+ai' : 'pinned-text+ai',
    interactive,
  });

  return {
    pinnedMessageId: pinnedMessage.message_id || null,
    pinnedSignature,
    pickupSummary: parsedContext.pickupSummary,
    deliverySummary: parsedContext.deliverySummary,
    destinationQuery: parsedContext.destinationQuery,
    source: parsedContext.source,
    pinnedText: parsedContext.pinnedText,
    aiModel: parsedContext.aiModel,
    extractedRawText: parsedContext.extractedRawText,
    loadInfoComplete: parsedContext.loadInfoComplete,
  };
}

async function readStoredRecentLoadContext({
  groupId,
  previousSignature = '',
  cachedDestinationQuery = '',
  cachedPickup = '',
  cachedDelivery = '',
}) {
  if (!groupId) return null;
  const db = require('../database/db');
  const rows = await db.getGroupRecentLoads(groupId, 2);
  if (!rows.length) return null;

  const chosen = pickStoredLoadForContext(rows, new Date());
  if (!chosen) return null;

  if (
    previousSignature
    && previousSignature === chosen.context_signature
    && normalizeLine(cachedDestinationQuery)
  ) {
    return {
      pinnedMessageId: chosen.telegram_message_id,
      pinnedSignature: chosen.context_signature,
      pickupSummary: normalizeLine(cachedPickup),
      deliverySummary: normalizeLine(cachedDelivery),
      destinationQuery: normalizeLine(cachedDestinationQuery),
      source: 'stored-recent-load-cache',
      pinnedText: chosen.caption_preview || '',
      aiModel: '',
      extractedRawText: '',
      loadInfoComplete: true,
    };
  }

  const pickupSummary = normalizeLine(chosen.pickup_summary);
  const deliverySummary = normalizeLine(chosen.delivery_summary);
  const destinationQuery = normalizeLine(chosen.destination_query);

  return {
    pinnedMessageId: chosen.telegram_message_id,
    pinnedSignature: chosen.context_signature,
    pickupSummary,
    deliverySummary,
    destinationQuery,
    source: 'stored-recent-load',
    pinnedText: chosen.caption_preview || '',
    aiModel: chosen.ai_model || '',
    extractedRawText: '',
    loadInfoComplete: isLoadContextComplete({
      pickupSummary,
      deliverySummary,
      destinationQuery,
    }),
  };
}

/**
 * Primary source of truth: the driver's active load straight from the Datatruck
 * OpenAPI (matched by driver name). Returns the load-context shape, or null when
 * Datatruck is unconfigured / no order matches so the caller falls through to the
 * legacy stored/pinned/chat fallbacks. Never throws.
 */
async function readDatatruckLoadContext({ group = null, chatId = null }) {
  if (!datatruckLoadService.isConfigured()) return null;
  let resolvedGroup = group;
  try {
    if (!resolvedGroup && chatId != null) {
      const db = require('../database/db');
      resolvedGroup = await db.getGroupByTelegramId(chatId);
    }
    if (!resolvedGroup) return null;
    const load = await datatruckLoadService.resolveActiveLoadForGroup(resolvedGroup);
    if (!load) return null;
    return {
      pinnedMessageId: null,
      pinnedSignature: load.orderId ? `datatruck:${load.orderId}` : '',
      pickupSummary: normalizeLine(load.pickupSummary),
      deliverySummary: normalizeLine(load.deliverySummary),
      destinationQuery: normalizeLine(load.destinationQuery),
      source: 'datatruck',
      pinnedText: '',
      aiModel: '',
      extractedRawText: '',
      orderId: load.orderId,
      loadIdentifier: load.loadIdentifier,
      status: load.status,
      miles: load.miles,
      loadInfoComplete: isLoadContextComplete({
        pickupSummary: load.pickupSummary,
        deliverySummary: load.deliverySummary,
        destinationQuery: load.destinationQuery,
      }),
    };
  } catch (err) {
    console.warn('[DISPATCH-ETA] Datatruck load lookup failed:', err.message);
    return null;
  }
}

async function readLoadContextWithFallbacks({
  telegram,
  chatId,
  group = null,
  groupId = null,
  previousSignature = '',
  cachedDestinationQuery = '',
  cachedPickup = '',
  cachedDelivery = '',
  interactive = false,
}) {
  const attempts = [];
  let firstContext = null;

  // 1) Datatruck active order (primary source — no Telegram/OCR/AI parsing).
  const datatruckContext = await readDatatruckLoadContext({ group, chatId });
  if (datatruckContext) {
    attempts.push('datatruck');
    if (isLoadContextComplete(datatruckContext)) {
      return {
        ...datatruckContext,
        loadInfoComplete: true,
        fallbackLevel: 0,
        fallbackAttempts: attempts,
      };
    }
    firstContext = datatruckContext;
  }

  try {
    const storedContext = await readStoredRecentLoadContext({
      groupId,
      previousSignature,
      cachedDestinationQuery,
      cachedPickup,
      cachedDelivery,
    });
    if (storedContext) {
      attempts.push(storedContext.source || 'stored');
      if (isLoadContextComplete(storedContext)) {
        return {
          ...storedContext,
          loadInfoComplete: true,
          fallbackLevel: 0,
          fallbackAttempts: attempts,
        };
      }
      firstContext = storedContext;
    }
  } catch (err) {
    attempts.push(`stored-error:${err.message}`);
  }

  try {
    const pinnedContext = await readPinnedLoadContext({
      telegram,
      chatId,
      groupId,
      previousSignature,
      cachedDestinationQuery,
      cachedPickup,
      cachedDelivery,
      interactive,
    });
    attempts.push(pinnedContext.source || 'pinned');
    if (isLoadContextComplete(pinnedContext)) {
      return {
        ...pinnedContext,
        loadInfoComplete: true,
        fallbackLevel: 1,
        fallbackAttempts: attempts,
      };
    }
    if (!firstContext) {
      firstContext = pinnedContext;
    }
  } catch (err) {
    attempts.push(`pinned-error:${err.code || 'unknown'}`);
  }

  const fallbackMessage = await getLatestLoadLikeChatMessageFromHistory(groupId);
  if (fallbackMessage?.messageText) {
    const historyContext = await buildLoadContextFromText({
      pinnedText: fallbackMessage.messageText,
      sourceLabel: 'chat-history+ai',
      interactive,
    });
    const withMetadata = {
      ...historyContext,
      pinnedMessageId: null,
      pinnedSignature: '',
      historyMessageCreatedAt: fallbackMessage.createdAt,
      historyMessageId: fallbackMessage.messageId,
      historyMessageSender: fallbackMessage.senderName,
      fallbackLevel: 3,
      fallbackAttempts: [...attempts, 'chat-history'],
    };
    if (isLoadContextComplete(withMetadata)) {
      return {
        ...withMetadata,
        loadInfoComplete: true,
      };
    }
    if (!firstContext) {
      firstContext = withMetadata;
    }
  } else {
    attempts.push('chat-history-missing');
  }

  if (firstContext && isLoadContextComplete(firstContext)) {
    return {
      ...firstContext,
      loadInfoComplete: true,
      fallbackAttempts: attempts,
    };
  }

  const err = new Error(NO_CURRENT_LOAD_INFO_MESSAGE);
  err.code = 'LOAD_CONTEXT_NOT_FOUND';
  err.fallbackAttempts = attempts;
  throw err;
}

module.exports = {
  buildLoadContextFromText,
  buildPinnedSignature,
  choosePinnedMessageCandidate,
  downloadTelegramFileBuffer,
  getLatestLoadLikeChatMessageFromHistory,
  getPinnedFileDescriptor,
  inferDestinationFromPinnedText,
  isLoadContextComplete,
  isLoadLikeChatMessage,
  NO_CURRENT_LOAD_INFO_MESSAGE,
  readDatatruckLoadContext,
  readLoadContextWithFallbacks,
  readPinnedLoadContext,
  readStoredRecentLoadContext,
};
