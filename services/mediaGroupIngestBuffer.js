/**
 * Telegram sends photo/document albums as multiple messages sharing media_group_id.
 * Collect pieces briefly, then flush one combined ingestion.
 */

const FLUSH_MS = 1400;
const buffers = new Map();

function bufferKey(telegramGroupId, mediaGroupId) {
  return `${telegramGroupId}:${mediaGroupId}`;
}

/**
 * @param {object} params
 * @param {import('telegraf').Telegram} params.telegram
 * @param {object} params.group — db row
 * @param {object} params.message — Telegram message
 * @param {Function} params.onFlush — async (telegram, group, messages[]) => void
 */
function scheduleAlbumPiece({ telegram, group, message, onFlush }) {
  const mg = message?.media_group_id;
  if (mg == null || mg === undefined) {
    return false;
  }

  const key = bufferKey(group.telegram_group_id, mg);
  let entry = buffers.get(key);
  if (!entry) {
    entry = {
      telegram,
      group,
      messages: [],
      timer: null,
      onFlush,
    };
    buffers.set(key, entry);
  }

  entry.messages.push(message);

  if (entry.timer) {
    clearTimeout(entry.timer);
  }

  entry.timer = setTimeout(() => {
    buffers.delete(key);
    const sorted = [...entry.messages].sort((a, b) => a.message_id - b.message_id);
    Promise.resolve()
      .then(() => entry.onFlush(entry.telegram, entry.group, sorted))
      .catch((err) => {
        console.warn('[LOAD-ALBUM] Flush failed:', err.message);
      });
  }, FLUSH_MS);

  return true;
}

/** Test helper: pending buffers count */
function __pendingBufferCount() {
  return buffers.size;
}

module.exports = {
  scheduleAlbumPiece,
  __pendingBufferCount,
  FLUSH_MS,
};
