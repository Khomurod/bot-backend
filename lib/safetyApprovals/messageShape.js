'use strict';

/**
 * A Telegram message as the Safety-approvals capture stores it. Pure.
 *
 * Only Telegram FILE IDS are kept for photos and documents, never bytes: the
 * bot that captured them can send them on by id, and nothing else can use one.
 *
 * A FORUM-TOPIC MESSAGE IS NOT A REPLY TO ITS TOPIC. In a group with topics,
 * Telegram fills `reply_to_message` on every message posted in a topic with the
 * topic's own opening message — even when nobody pressed "reply". Read naively,
 * every message in the recruiting topic would be "a reply to the topic", and
 * Safety's every word would be matched to nothing. Only a reply to something
 * other than the topic root is a reply here.
 */

function senderName(from) {
  if (!from) return null;
  const full = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  return from.username ? `@${from.username}` : null;
}

/** The biggest rendition Telegram sent of one photo. */
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

/** The message this one really replies to, or null (see the header). */
function replyTarget(message) {
  const target = message.reply_to_message;
  if (!target || target.message_id == null) return null;
  if (target.forum_topic_created) return null;
  if (message.is_topic_message && target.message_id === message.message_thread_id) return null;
  return target.message_id;
}

/**
 * Who a FORWARDED message is really from. Safety sometimes forwards a
 * recruiter's post into the group; the message is then Safety's, but the post
 * is the recruiter's. Bot API 7 `forward_origin`, with the older fields as a
 * fallback. A hidden user has a name and no id.
 */
function forwardOrigin(message) {
  const origin = message.forward_origin;
  if (origin?.type === 'user' && origin.sender_user) {
    return { userId: origin.sender_user.id ?? null, name: senderName(origin.sender_user) };
  }
  if (origin?.type === 'hidden_user') return { userId: null, name: origin.sender_user_name || null };
  if (origin?.type === 'chat' || origin?.type === 'channel') {
    const chat = origin.sender_chat || origin.chat;
    return { userId: null, name: chat?.title || null };
  }
  if (message.forward_from) return { userId: message.forward_from.id ?? null, name: senderName(message.forward_from) };
  if (message.forward_sender_name) return { userId: null, name: message.forward_sender_name };
  return null;
}

function toDate(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

/**
 * @returns {object|null} the record, or null for something that is not a
 *   message at all.
 */
function shapeCapturedMessage(message) {
  if (!message || !message.chat || message.message_id == null) return null;
  const photos = Array.isArray(message.photo) && message.photo.length
    ? [largestPhoto(message.photo)]
    : [];
  const doc = message.document;
  const documents = doc && doc.file_id
    ? [{
      file_id: doc.file_id,
      file_unique_id: doc.file_unique_id || null,
      file_name: doc.file_name || null,
      mime_type: doc.mime_type || null,
      file_size: doc.file_size || null,
    }]
    : [];
  const text = message.text ?? message.caption ?? null;
  const forwarded = forwardOrigin(message);
  return {
    chatId: String(message.chat.id),
    messageId: message.message_id,
    threadId: message.message_thread_id ?? null,
    mediaGroupId: message.media_group_id ?? null,
    fromUserId: message.from?.id ?? null,
    fromName: senderName(message.from),
    fromIsBot: Boolean(message.from?.is_bot),
    forwardedFromUserId: forwarded?.userId ?? null,
    forwardedFromName: forwarded?.name ?? null,
    text: typeof text === 'string' && text.trim() ? text : null,
    photos,
    documents,
    replyToMessageId: replyTarget(message),
    sentAt: toDate(message.date),
    editedAt: toDate(message.edit_date),
  };
}

/** Is this document a picture someone sent "as a file"? */
function isImageDocument(doc) {
  return /^image\//i.test(String(doc?.mime_type || ''));
}

module.exports = { shapeCapturedMessage, isImageDocument, senderName };
