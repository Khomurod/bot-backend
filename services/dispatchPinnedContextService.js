const crypto = require('node:crypto');
const { extractRateConRawTextFromFile } = require('../server/services/dispatchParserService');
const { pickStoredLoadForContext } = require('./recentLoadSelection');

const GROQ_API_KEY = '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';
const PINNED_CONTEXT_GROQ_MODELS = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-20b',
];
const GEMINI_API_KEY = 'AIzaSyAuDwDmasf2KKl8MXYQUiNMVPpokVVmptw';
const MAX_INLINE_GEMINI_FILE_BYTES = 14 * 1024 * 1024;
const PINNED_CONTEXT_GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-3-flash',
  'gemini-3.1-flash',
  'gemini-2.0-flash',
  'gemma-3-12b-it',
  'gemma-3-4b-it',
  'gemma-3-1b-it',
];
const CHAT_HISTORY_LOOKBACK_DAYS = 8;
const LOAD_LIKE_CHAT_MESSAGE_REGEX = /(load\s*#|load\s*id|rate.?confirm|carrier_rate|secure.?rate.?con|\.pdf\b|live\s*[-/\\]\s*live|drop\s*[-/\\]?\s*hook|hook\s*[-/\\]?\s*drop|[A-Z]{2}\s*[-/>]+\s*[A-Z]{2})/i;
const STALE_STATUS_CHAT_MESSAGE_REGEX = /\b(pod|completed|cancel(?:led)?|picked up|status\s*:|rolling|stopped|miles?\s+left)\b/i;
const NO_CURRENT_LOAD_INFO_MESSAGE = 'No information about the current load is found';

async function getPinnedSnapshotFromDb(groupId) {
  if (!groupId) return null;
  try {
    const db = require('../database/db');
    return await db.getGroupPinnedMessageSnapshot(groupId);
  } catch (err) {
    console.warn('[DISPATCH-ETA] Could not read pinned snapshot from DB:', err.message);
    return null;
  }
}

function normalizeLine(line) {
  return String(line || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLoadLikeChatMessage(text) {
  const source = String(text || '');
  if (!source.trim()) return false;
  if (/^\s*\/(?:location|update|status)\b/i.test(source)) return false;
  return LOAD_LIKE_CHAT_MESSAGE_REGEX.test(source);
}

function isLikelyStaleStatusMessage(text) {
  const source = String(text || '');
  return STALE_STATUS_CHAT_MESSAGE_REGEX.test(source);
}

function isLoadContextComplete(context) {
  return Boolean(
    normalizeLine(context?.pickupSummary)
    && normalizeLine(context?.deliverySummary)
    && normalizeLine(context?.destinationQuery)
  );
}

function getPinnedFileDescriptor(message) {
  if (!message || typeof message !== 'object') return null;

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    return {
      fileId: largest?.file_id || '',
      fileUniqueId: largest?.file_unique_id || '',
      mimeType: 'image/jpeg',
      filename: 'pinned-photo.jpg',
    };
  }

  if (message.document?.file_id) {
    return {
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id || '',
      mimeType: message.document.mime_type || 'application/octet-stream',
      filename: message.document.file_name || 'pinned-document',
    };
  }

  return null;
}

function buildPinnedSignature({ pinnedMessage, text, fileDescriptor }) {
  const hash = crypto.createHash('sha1');
  hash.update(String(pinnedMessage?.message_id || ''));
  hash.update('|');
  hash.update(String(pinnedMessage?.date || ''));
  hash.update('|');
  hash.update(String(pinnedMessage?.edit_date || ''));
  hash.update('|');
  hash.update(String(fileDescriptor?.fileUniqueId || fileDescriptor?.fileId || ''));
  hash.update('|');
  hash.update(String(text || ''));
  return hash.digest('hex');
}

function stripJsonFences(text) {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function safeParseJsonObject(text) {
  const raw = stripJsonFences(text);
  try {
    const direct = JSON.parse(raw);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  } catch {
    // continue
  }

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const slice = raw.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(slice);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // ignore
    }
  }

  return null;
}

async function downloadTelegramFileBuffer(telegram, fileId) {
  const fileUrl = await telegram.getFileLink(fileId);
  const response = await fetch(String(fileUrl), {
    headers: {
      'User-Agent': 'DispatchBot/1.0',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to download pinned file (${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function inferDestinationFromPinnedText(text) {
  const source = String(text || '');
  const cityZipMatches = Array.from(
    source.matchAll(/\b([A-Za-z.' -]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)\b/g)
  ).map((match) => normalizeLine(match[1]));
  if (cityZipMatches.length > 0) return cityZipMatches[cityZipMatches.length - 1];

  const plainMatches = Array.from(
    source.matchAll(/\b([A-Za-z.' -]+\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)\b/g)
  ).map((match) => normalizeLine(match[1]));
  if (plainMatches.length > 0) return plainMatches[plainMatches.length - 1];

  const stateRoute = source.match(/\b([A-Z]{2})\s*>\s*([A-Z]{2})\b/i);
  if (stateRoute) return `${stateRoute[2].toUpperCase()}, USA`;

  return '';
}

function getPinnedMessageDate(message) {
  const unix = Number(message?.date || 0);
  return Number.isFinite(unix) && unix > 0 ? unix : 0;
}

function choosePinnedMessageCandidate({
  chatPinnedMessage,
  snapshotPinnedMessage,
  snapshotSourceEventAt,
}) {
  if (!snapshotPinnedMessage) return chatPinnedMessage || null;
  if (!chatPinnedMessage) return snapshotPinnedMessage;

  if (snapshotPinnedMessage.message_id === chatPinnedMessage.message_id) {
    return chatPinnedMessage;
  }

  const snapshotEventMs = Date.parse(String(snapshotSourceEventAt || ''));
  if (Number.isFinite(snapshotEventMs)) {
    return snapshotPinnedMessage;
  }

  const chatDate = getPinnedMessageDate(chatPinnedMessage);
  const snapshotDate = getPinnedMessageDate(snapshotPinnedMessage);
  if (snapshotDate >= chatDate) return snapshotPinnedMessage;
  return chatPinnedMessage;
}

function cleanDestinationCandidate(value) {
  return normalizeLine(value)
    .replace(/\|\s*[^|]*$/g, '')
    .replace(/\b(?:appt|appointment)\b.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isWeakDestinationQuery(value) {
  const text = cleanDestinationCandidate(value).toLowerCase();
  if (!text) return true;
  if (text.length < 6) return true;
  if (text === 'usa') return true;
  if (text.includes('street address')) return true;
  if (text.includes('unknown')) return true;
  return false;
}

function chooseBestDestinationQuery({
  aiDestination,
  pickupLocation,
  deliveryLocation,
  fallbackDestination,
}) {
  const aiCandidate = cleanDestinationCandidate(aiDestination);
  const pickupCandidate = cleanDestinationCandidate(pickupLocation);
  const deliveryCandidate = cleanDestinationCandidate(deliveryLocation);
  const fallbackCandidate = cleanDestinationCandidate(fallbackDestination);

  const aiLooksLikePickup = Boolean(
    aiCandidate
    && pickupCandidate
    && aiCandidate.toLowerCase() === pickupCandidate.toLowerCase()
    && (!deliveryCandidate || aiCandidate.toLowerCase() !== deliveryCandidate.toLowerCase())
  );

  if (!isWeakDestinationQuery(aiCandidate) && !aiLooksLikePickup) {
    return aiCandidate;
  }
  if (!isWeakDestinationQuery(deliveryCandidate)) {
    return deliveryCandidate;
  }
  if (!isWeakDestinationQuery(fallbackCandidate)) {
    return fallbackCandidate;
  }

  return aiCandidate || deliveryCandidate || fallbackCandidate;
}

function buildPinnedContextPrompt({ pinnedText, extractedRawText }) {
  return [
    'You are a trucking dispatch assistant.',
    'Pinned Telegram load messages can be messy and inconsistent. Do not assume a fixed template.',
    'Answer these exact questions based on all provided content:',
    '1) What is the pickup location and pickup date/time?',
    '2) What is the delivery location and delivery date/time?',
    'Return JSON only with keys:',
    'pickup_location, pickup_datetime, delivery_location, delivery_datetime, destination_query, notes',
    'Rules:',
    '- If unknown, use empty string.',
    '- destination_query should be the best destination text for geocoding (prefer full street + city/state/zip).',
    '- No markdown, no explanation text.',
    '',
    'Pinned message text:',
    '<pinned_text>',
    pinnedText.slice(0, 6000),
    '</pinned_text>',
    '',
    'Extracted file text (if available):',
    '<extracted_file_text>',
    extractedRawText.slice(0, 10000),
    '</extracted_file_text>',
  ].join('\n');
}

function buildPinnedContextAiParts({ pinnedText, extractedRawText, sourceFile }) {
  const parts = [];
  const canInlineSourceFile = Boolean(
    sourceFile?.buffer
    && sourceFile?.mimetype
    && (sourceFile.mimetype === 'application/pdf' || sourceFile.mimetype.startsWith('image/'))
    && sourceFile.buffer.length <= MAX_INLINE_GEMINI_FILE_BYTES
  );

  if (canInlineSourceFile) {
    parts.push({
      inline_data: {
        mime_type: sourceFile.mimetype,
        data: sourceFile.buffer.toString('base64'),
      },
    });
  }

  const prompt = buildPinnedContextPrompt({ pinnedText, extractedRawText });

  parts.push({ text: prompt });
  return parts;
}

function buildPinnedContextGroqMessages({ pinnedText, extractedRawText }) {
  return [
    {
      role: 'system',
      content: 'You are a trucking dispatch assistant. Return a JSON object only. No markdown or extra text.',
    },
    {
      role: 'user',
      content: buildPinnedContextPrompt({ pinnedText, extractedRawText }),
    },
  ];
}

async function requestPinnedContextFromGroq({ pinnedText, extractedRawText }) {
  const attemptErrors = [];

  for (const model of PINNED_CONTEXT_GROQ_MODELS) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          seed: 7,
          max_completion_tokens: 700,
          response_format: { type: 'json_object' },
          messages: buildPinnedContextGroqMessages({ pinnedText, extractedRawText }),
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const apiMessage = payload?.error?.message || `Groq request failed with status ${response.status}`;
        attemptErrors.push({ model, status: response.status, message: apiMessage });
        continue;
      }

      const text = String(payload?.choices?.[0]?.message?.content || '').trim();
      if (!text) {
        attemptErrors.push({ model, status: null, message: 'Groq returned an empty response' });
        continue;
      }

      const parsed = safeParseJsonObject(text);
      if (!parsed) {
        attemptErrors.push({ model, status: null, message: 'Groq returned non-JSON output' });
        continue;
      }

      return {
        model,
        fields: {
          pickupLocation: normalizeLine(parsed.pickup_location || ''),
          pickupDateTime: normalizeLine(parsed.pickup_datetime || ''),
          deliveryLocation: normalizeLine(parsed.delivery_location || ''),
          deliveryDateTime: normalizeLine(parsed.delivery_datetime || ''),
          destinationQuery: normalizeLine(parsed.destination_query || ''),
          notes: normalizeLine(parsed.notes || ''),
        },
      };
    } catch (err) {
      attemptErrors.push({ model, status: null, message: err.message });
    }
  }

  const details = attemptErrors.map((e) => `${e.model}: ${e.message}`).join('; ');
  throw new Error(details || 'All pinned-context Groq models failed');
}

async function requestPinnedContextFromGemini({ pinnedText, extractedRawText, sourceFile }) {
  const contents = [
    {
      parts: buildPinnedContextAiParts({ pinnedText, extractedRawText, sourceFile }),
    },
  ];

  const attemptErrors = [];
  for (const model of PINNED_CONTEXT_GEMINI_MODELS) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_API_KEY,
          },
          body: JSON.stringify({
            contents,
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 800,
              responseMimeType: 'text/plain',
            },
          }),
        }
      );

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const apiMessage = payload?.error?.message || `Gemini request failed with status ${response.status}`;
        attemptErrors.push({ model, status: response.status, message: apiMessage });
        continue;
      }

      const text = (payload?.candidates || [])
        .flatMap((candidate) => candidate?.content?.parts || [])
        .map((part) => part?.text || '')
        .join('')
        .trim();
      if (!text) {
        const finishReason = payload?.candidates?.[0]?.finishReason || 'UNKNOWN';
        attemptErrors.push({ model, status: null, message: `Gemini returned empty response (${finishReason})` });
        continue;
      }

      const parsed = safeParseJsonObject(text);
      if (!parsed) {
        attemptErrors.push({ model, status: null, message: 'Gemini returned non-JSON output' });
        continue;
      }

      return {
        model,
        fields: {
          pickupLocation: normalizeLine(parsed.pickup_location || ''),
          pickupDateTime: normalizeLine(parsed.pickup_datetime || ''),
          deliveryLocation: normalizeLine(parsed.delivery_location || ''),
          deliveryDateTime: normalizeLine(parsed.delivery_datetime || ''),
          destinationQuery: normalizeLine(parsed.destination_query || ''),
          notes: normalizeLine(parsed.notes || ''),
        },
      };
    } catch (err) {
      attemptErrors.push({ model, status: null, message: err.message });
    }
  }

  const details = attemptErrors.map((e) => `${e.model}: ${e.message}`).join('; ');
  throw new Error(details || 'All pinned-context AI models failed');
}

async function buildLoadContextFromText({
  pinnedText,
  extractedRawText = '',
  sourceFile = null,
  sourceLabel = 'pinned-text+ai',
}) {
  const normalizedPinnedText = String(pinnedText || '').trim();
  const normalizedExtractedText = String(extractedRawText || '').trim();

  let aiResult = null;
  try {
    aiResult = await requestPinnedContextFromGroq({
      pinnedText: normalizedPinnedText,
      extractedRawText: normalizedExtractedText,
    });
  } catch (err) {
    console.warn('[DISPATCH-ETA] Pinned-context Groq parse failed:', err.message);
  }

  if (!aiResult) {
    try {
      aiResult = await requestPinnedContextFromGemini({
        pinnedText: normalizedPinnedText,
        extractedRawText: normalizedExtractedText,
        sourceFile,
      });
    } catch (err) {
      console.warn('[DISPATCH-ETA] Pinned-context Gemini parse failed:', err.message);
    }
  }

  const fallbackDestination = inferDestinationFromPinnedText(
    [normalizedPinnedText, normalizedExtractedText].filter(Boolean).join('\n')
  );
  const pickupSummary = normalizeLine(aiResult?.fields?.pickupLocation || '');
  const pickupDateTime = normalizeLine(aiResult?.fields?.pickupDateTime || '');
  const deliverySummary = normalizeLine(aiResult?.fields?.deliveryLocation || '');
  const deliveryDateTime = normalizeLine(aiResult?.fields?.deliveryDateTime || '');
  const destinationQuery = chooseBestDestinationQuery({
    aiDestination: aiResult?.fields?.destinationQuery || '',
    pickupLocation: pickupSummary,
    deliveryLocation: deliverySummary,
    fallbackDestination,
  });

  const pickupSummaryLine = [pickupSummary, pickupDateTime].filter(Boolean).join(' | ');
  const deliverySummaryLine = [deliverySummary, deliveryDateTime].filter(Boolean).join(' | ');

  const aiFieldsJson = aiResult
    ? {
        pickup_location: aiResult.fields.pickupLocation,
        pickup_datetime: aiResult.fields.pickupDateTime,
        delivery_location: aiResult.fields.deliveryLocation,
        delivery_datetime: aiResult.fields.deliveryDateTime,
        destination_query: aiResult.fields.destinationQuery,
        notes: aiResult.fields.notes,
      }
    : null;

  return {
    pickupSummary: pickupSummaryLine,
    deliverySummary: deliverySummaryLine,
    destinationQuery,
    source: sourceLabel,
    pinnedText: normalizedPinnedText,
    aiModel: aiResult?.model || '',
    extractedRawText: normalizedExtractedText,
    pickupDateTimeRaw: pickupDateTime,
    deliveryDateTimeRaw: deliveryDateTime,
    aiFieldsJson,
    loadInfoComplete: isLoadContextComplete({
      pickupSummary: pickupSummaryLine,
      deliverySummary: deliverySummaryLine,
      destinationQuery,
    }),
  };
}

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

async function readLoadContextWithFallbacks({
  telegram,
  chatId,
  groupId = null,
  previousSignature = '',
  cachedDestinationQuery = '',
  cachedPickup = '',
  cachedDelivery = '',
}) {
  const attempts = [];
  let firstContext = null;

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
  readLoadContextWithFallbacks,
  readPinnedLoadContext,
  readStoredRecentLoadContext,
};
