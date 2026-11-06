'use strict';

/**
 * Reading the parts of a Telegram message that more than one feature stores.
 * Pure.
 *
 * Moved out of lib/safetyApprovals/messageShape.js (November 2026) when Truck
 * Photos needed the same three readings for driver groups: who sent it, the
 * biggest rendition of a photo, and whether a document is a picture sent "as a
 * file". One reading each, so the two features cannot disagree about what a
 * photo is.
 *
 * A FORUM-TOPIC MESSAGE IS NOT A REPLY TO ITS TOPIC. In a group with topics,
 * Telegram fills `reply_to_message` on every message posted in a topic with the
 * topic's own opening message — even when nobody pressed "reply". Only a reply
 * to something other than the topic root is a reply here.
 */

/** The name Telegram shows for a sender, or null. */
function senderName(from) {
  if (!from) return null;
  const full = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  return from.username ? `@${from.username}` : null;
}

/** The biggest rendition Telegram sent of one photo (`message.photo` is every size). */
function largestPhoto(sizes) {
  const best = sizes.reduce((pick, size) => {
    const area = (size.width || 0) * (size.height || 0);
    return !pick || area > pick.area ? { size, area } : pick;
  }, null).size;
  return {
    file_id: best.file_id,
    file_unique_id: best.file_unique_id || null,
    width: best.width || null,
    height: best.height || null,
    file_size: best.file_size || null,
  };
}

/** Is this document a picture someone sent "as a file"? */
function isImageDocument(doc) {
  return /^image\//i.test(String(doc?.mime_type || ''));
}

/** The message this one really replies to, or null (see the header). */
function replyTarget(message) {
  const target = message?.reply_to_message;
  if (!target || target.message_id == null) return null;
  if (target.forum_topic_created) return null;
  if (message.is_topic_message && target.message_id === message.message_thread_id) return null;
  return target.message_id;
}

module.exports = {
  senderName, largestPhoto, isImageDocument, replyTarget,
};
