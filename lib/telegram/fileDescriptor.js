'use strict';

/**
 * What file is attached to a Telegram message, in four fields. PURE.
 *
 * Telegram hands an attachment over in two shapes and neither is convenient:
 * a photo is an ARRAY of sizes with the largest last and no mime type or name
 * at all, while a document is one object whose `mime_type` and `file_name` are
 * both optional. Every caller that wants "the file on this message" has to know
 * both shapes, and each one that learns them separately learns them slightly
 * differently.
 *
 * MOVED here from services/pinnedContext/pinnedSource.js, which had it first
 * for the pinned rate confirmation. The Finance Monitor's document capture asks
 * the same question of a different message, and `lib/` is where something two
 * layers need with no I/O and no state belongs — copying it would have been the
 * second of three subtly different readings of `message.photo`.
 *
 * `fileUniqueId` is the stable one: `file_id` is per-bot and can be reissued,
 * `file_unique_id` identifies the same file forever and is what a "have we
 * already read this?" key is built from. It is returned as '' rather than null
 * when Telegram omits it, because the callers store it in a NOT NULL column.
 */

/**
 * @param {object} message a Telegram message
 * @returns {{fileId:string, fileUniqueId:string, mimeType:string, filename:string,
 *   kind:'photo'|'document', fileSize:number|null}|null} null when nothing is attached
 */
function getTelegramFileDescriptor(message) {
  if (!message || typeof message !== 'object') return null;

  // A photo arrives as an ascending array of sizes. The last is the largest,
  // which is the only one worth reading text out of.
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    return {
      fileId: largest?.file_id || '',
      fileUniqueId: largest?.file_unique_id || '',
      mimeType: 'image/jpeg',
      filename: 'pinned-photo.jpg',
      kind: 'photo',
      fileSize: Number.isFinite(largest?.file_size) ? largest.file_size : null,
    };
  }

  if (message.document?.file_id) {
    return {
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id || '',
      // Telegram omits mime_type often enough that a caller gating on it must
      // have something to gate on. octet-stream is the honest "unknown", and
      // the finance reader treats it as unsupported rather than guessing.
      mimeType: message.document.mime_type || 'application/octet-stream',
      filename: message.document.file_name || 'pinned-document',
      kind: 'document',
      fileSize: Number.isFinite(message.document.file_size) ? message.document.file_size : null,
    };
  }

  return null;
}

module.exports = { getTelegramFileDescriptor };
