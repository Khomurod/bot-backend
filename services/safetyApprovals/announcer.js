'use strict';

/**
 * Posting one driver's decision in the approvals topic: ONE block of files —
 * the CDL as a file, then every document Safety attached (PSP, MVR, CLH) —
 * with the status, name and phone under it (the owner's choice, 16 Oct 2026).
 *
 * WHY THE CDL IS UPLOADED AGAIN. Telegram will not put a photo and documents
 * in one album, and a photo's file id cannot be re-sent as a document. So the
 * CDL's bytes, already fetched for the model, are uploaded once more as a
 * file. Safety's documents are re-sent by file id: no bytes are downloaded.
 *
 * A post with nothing to attach is a plain message; one file is one document.
 * Telegram allows ten items in an album, so at most nine of Safety's files go
 * beside the CDL.
 */

const MAX_ALBUM = 10;

function extensionFor(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/heic') return 'heic';
  return 'jpg';
}

function safeFileName(name) {
  return String(name || 'driver').replace(/[^\p{L}\p{N} .,'-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
    || 'driver';
}

/**
 * The items to send, in order: the CDL first, then Safety's files.
 *
 * @param {{buffer: Buffer, mimeType: string}|null} cdl
 * @param {{fileId: string}[]} documents
 */
function buildItems({ name, cdl, documents }) {
  const items = [];
  if (cdl?.buffer) {
    items.push({ source: cdl.buffer, filename: `CDL - ${safeFileName(name)}.${extensionFor(cdl.mimeType)}` });
  }
  for (const doc of documents || []) {
    if (items.length >= MAX_ALBUM) break;
    if (doc?.fileId) items.push(doc.fileId);
  }
  return items;
}

/**
 * @returns {Promise<number[]>} the ids of the messages posted in the topic
 */
async function postDecision(telegram, { chatId, topicId, caption, name, cdl, documents }) {
  const items = buildItems({ name, cdl, documents });
  const thread = { message_thread_id: topicId };

  if (!items.length) {
    const sent = await telegram.sendMessage(chatId, caption, {
      ...thread, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    });
    return [sent.message_id];
  }

  if (items.length === 1) {
    const sent = await telegram.sendDocument(chatId, items[0], { ...thread, caption, parse_mode: 'HTML' });
    return [sent.message_id];
  }

  const media = items.map((item, index) => ({
    type: 'document',
    media: item,
    ...(index === items.length - 1 ? { caption, parse_mode: 'HTML' } : {}),
  }));
  const sent = await telegram.sendMediaGroup(chatId, media, thread);
  return (Array.isArray(sent) ? sent : []).map((m) => m.message_id);
}

module.exports = {
  postDecision,
  buildItems,
  safeFileName,
  MAX_ALBUM,
};
