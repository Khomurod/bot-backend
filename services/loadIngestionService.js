const crypto = require('node:crypto');
const db = require('../database/db');
const { extractRateConRawTextFromFile } = require('../server/services/dispatchParserService');
const {
  buildLoadContextFromText,
  downloadTelegramFileBuffer,
  getPinnedFileDescriptor,
  isLoadLikeChatMessage,
} = require('./dispatchPinnedContextService');
const { inferWindowsFromAiDateTimeStrings } = require('./loadWindowParse');

function buildContextSignature({
  telegramMessageId,
  destinationQuery,
  pickupSummary,
  deliverySummary,
}) {
  return crypto
    .createHash('sha1')
    .update([telegramMessageId, pickupSummary, deliverySummary, destinationQuery].join('\u001f'))
    .digest('hex');
}

/**
 * True for PDF/image docs or photos, or load-like caption/text.
 */
function isCandidateLoadMessage(message) {
  if (!message) return false;

  if (message.document) {
    const mime = message.document.mime_type || '';
    const name = String(message.document.file_name || '').toLowerCase();
    if (mime === 'application/pdf' || name.endsWith('.pdf')) return true;
    if (mime.startsWith('image/')) return true;
  }

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    return true;
  }

  const text = [message.text, message.caption].filter(Boolean).join('\n');
  return isLoadLikeChatMessage(text);
}

async function ingestLoadMessage(telegram, group, message) {
  if (!group?.id || group.group_type !== 'driver' || !group.active) {
    return null;
  }
  if (!isCandidateLoadMessage(message)) {
    return null;
  }

  const telegramMessageId = message.message_id;
  const already = await db.hasGroupRecentLoadForMessage(group.id, telegramMessageId);
  if (already) {
    return null;
  }

  const caption = [message.text, message.caption].filter(Boolean).join('\n').trim();
  const fileDescriptor = getPinnedFileDescriptor(message);

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
      console.warn('[LOAD-INGEST] Media extraction failed:', err.message);
    }
  }

  const pinnedInput = caption || extractedRawText.slice(0, 800) || '[no caption — attachment only]';

  const parsed = await buildLoadContextFromText({
    pinnedText: pinnedInput,
    extractedRawText,
    sourceFile,
    sourceLabel: fileDescriptor ? 'ingest-media+ai' : 'ingest-text+ai',
  });

  const dest = String(parsed.destinationQuery || '').trim();
  const pickup = String(parsed.pickupSummary || '').trim();
  const delivery = String(parsed.deliverySummary || '').trim();

  if (!dest && !pickup && !delivery) {
    console.warn('[LOAD-INGEST] No extractable load fields for message', telegramMessageId);
    return null;
  }

  const sig = buildContextSignature({
    telegramMessageId,
    destinationQuery: dest,
    pickupSummary: pickup,
    deliverySummary: delivery,
  });

  const ai = parsed.aiFieldsJson || {};
  const windows = inferWindowsFromAiDateTimeStrings(
    ai.pickup_datetime || parsed.pickupDateTimeRaw,
    ai.delivery_datetime || parsed.deliveryDateTimeRaw
  );

  const messageUnix = Number(message.date);
  const sourceMessageAt =
    Number.isFinite(messageUnix) && messageUnix > 0
      ? new Date(messageUnix * 1000).toISOString()
      : null;

  let loadIdentifier = null;
  const loadMatch = caption.match(/\b(?:load\s*#|load\s*id)\s*:?\s*([A-Za-z0-9\-]+)/i);
  if (loadMatch) {
    loadIdentifier = loadMatch[1];
  }

  await db.insertGroupRecentLoad({
    groupId: group.id,
    telegramMessageId,
    sourceMessageAt,
    contextSignature: sig,
    pickupSummary: pickup,
    deliverySummary: delivery,
    destinationQuery: dest,
    pickupWindowStart: windows.pickup_window_start,
    pickupWindowEnd: windows.pickup_window_end,
    deliveryWindowStart: windows.delivery_window_start,
    deliveryWindowEnd: windows.delivery_window_end,
    loadIdentifier,
    captionPreview: caption.slice(0, 2000),
    extractedRawJson: {
      aiFields: parsed.aiFieldsJson,
      source: parsed.source,
      aiModel: parsed.aiModel || '',
    },
    aiModel: parsed.aiModel || null,
  });

  console.log(
    `[LOAD-INGEST] Stored load context for group ${group.id} msg ${telegramMessageId} (${parsed.source})`
  );

  return { ok: true };
}

function scheduleLoadIngest(telegram, group, message) {
  setImmediate(() => {
    ingestLoadMessage(telegram, group, message).catch((err) => {
      console.warn('[LOAD-INGEST] Failed:', err.message);
    });
  });
}

module.exports = {
  scheduleLoadIngest,
  ingestLoadMessage,
  isCandidateLoadMessage,
};
