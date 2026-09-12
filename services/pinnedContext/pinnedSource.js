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
// The photo/document shapes are lib's now: the Finance Monitor asks the same
// question of a different message, and two readings of `message.photo` would
// have drifted. Re-exported under the old name so no caller here changed.
const { getTelegramFileDescriptor } = require('../../lib/telegram/fileDescriptor');

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
  getPinnedFileDescriptor: getTelegramFileDescriptor,
  buildPinnedSignature,
  downloadTelegramFileBuffer,
};
