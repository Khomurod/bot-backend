'use strict';

/**
 * Remembering the photos sent in driver groups, quietly, while Truck Photos is on.
 *
 * WHY. When somebody writes `outbound` or `inbound`, the PDF is made of the
 * photos sent before it — and a bot cannot read a chat's history. So every
 * photo (its largest size) and every picture sent "as a file" in a DRIVER
 * group is remembered as it arrives: its Telegram file id, who sent it, when,
 * and its album. Never the bytes (database/truckPhotos/photos.js).
 *
 * AN OBSERVER. It never consumes a message, never answers, and NEVER THROWS:
 * a rejection inside the bot's message handler reaches index.js's
 * `unhandledRejection` hook, which exits the process. A failure costs the one
 * photo and is logged without anything from the message.
 *
 * CHEAP ON THE HOT PATH. A message without a picture costs nothing — not even
 * a settings read. With one, the settings and the group row both come from
 * caches the message pipeline already keeps warm; the only database trip is
 * the INSERT, and only while the feature is on.
 *
 * The bot's own pictures are never remembered, so a PDF is never made of them.
 */

const {
  largestPhoto, isImageDocument, senderName,
} = require('../../lib/telegram/messageParts');

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    getSettings: require('../../database/truckPhotos/settings').getTruckPhotoSettings,
    getGroup: require('../../database/groups').getGroupByTelegramId,
    upsertPhoto: require('../../database/truckPhotos/photos').upsertPhoto,
  };
  /* eslint-enable global-require */
}

function isGroupChat(chat) {
  return chat?.type === 'group' || chat?.type === 'supergroup';
}

/** Does this message carry a picture at all? No I/O. */
function hasPicture(message) {
  if (Array.isArray(message?.photo) && message.photo.length) return true;
  return Boolean(message?.document?.file_id) && isImageDocument(message.document);
}

/**
 * The picture a message carries, as the buffer stores it; null for anything
 * else, or for a message a bot sent. Pure.
 */
function shapePhoto(message, group) {
  if (!message?.chat || message.message_id === null || message.message_id === undefined) return null;
  if (!message.from || message.from.is_bot) return null;
  let picture = null;
  let kind = null;
  if (Array.isArray(message.photo) && message.photo.length) {
    picture = largestPhoto(message.photo);
    kind = 'photo';
  } else if (message.document?.file_id && isImageDocument(message.document)) {
    const doc = message.document;
    picture = {
      file_id: doc.file_id, file_unique_id: doc.file_unique_id || null, width: null, height: null,
      file_size: doc.file_size || null,
    };
    kind = 'document';
  }
  if (!picture?.file_id) return null;
  return {
    chatId: String(message.chat.id),
    groupId: group.id,
    messageId: message.message_id,
    mediaGroupId: message.media_group_id ?? null,
    fromUserId: message.from.id ?? null,
    fromName: senderName(message.from),
    fileId: picture.file_id,
    fileUniqueId: picture.file_unique_id,
    kind,
    width: picture.width,
    height: picture.height,
    fileSize: picture.file_size,
    sentAt: Number.isFinite(message.date) ? new Date(message.date * 1000) : new Date(),
  };
}

/**
 * @param {object} message  a Telegram message
 * @returns {Promise<{captured: boolean, reason?: string}>}
 */
async function captureTruckPhoto(message, deps = defaultDeps()) {
  try {
    if (!message || !isGroupChat(message.chat)) return { captured: false, reason: 'not_a_group' };
    if (!hasPicture(message)) return { captured: false, reason: 'no_picture' };
    const settings = await deps.getSettings();
    if (!settings?.enabled) return { captured: false, reason: 'switched_off' };
    const group = await deps.getGroup(message.chat.id);
    if (!group || group.group_type !== 'driver') return { captured: false, reason: 'not_a_driver_group' };
    const shaped = shapePhoto(message, group);
    if (!shaped) return { captured: false, reason: 'not_a_person' };
    await deps.upsertPhoto(shaped);
    return { captured: true };
  } catch (err) {
    console.warn('[TRUCK PHOTOS] could not remember a photo:', err?.message || String(err));
    return { captured: false, reason: 'error' };
  }
}

module.exports = {
  captureTruckPhoto, shapePhoto, hasPicture, isGroupChat,
};
