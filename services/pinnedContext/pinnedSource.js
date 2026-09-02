/**
 * Reading the PINNED MESSAGE and its attachment from Telegram.
 *
 * `buildPinnedSignature` is what makes the snapshot cacheable — it changes when
 * the pinned message or its file changes, and only then is the document read
 * and re-parsed.
 *
 * Split out of services/dispatchPinnedContextService.js, which re-exports these.
 */
const crypto = require('node:crypto');

async function getPinnedSnapshotFromDb(groupId) {
  if (!groupId) return null;
  try {
    const db = require('../../database/db');
    return await db.getGroupPinnedMessageSnapshot(groupId);
  } catch (err) {
    console.warn('[DISPATCH-ETA] Could not read pinned snapshot from DB:', err.message);
    return null;
  }
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

module.exports = {
  getPinnedSnapshotFromDb,
  getPinnedFileDescriptor,
  buildPinnedSignature,
  downloadTelegramFileBuffer,
};
