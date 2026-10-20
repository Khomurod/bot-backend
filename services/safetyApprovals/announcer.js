'use strict';

/**
 * What the bot sends for Safety Approvals.
 *
 * IN THE APPROVALS TOPIC, one driver's decision is that driver's POST as the
 * recruiter sent it — the photos (the CDL), with the recruiter's words and the
 * decision as the caption (lib/safetyApprovals/announcement.js). The owner's
 * layout of 20 October 2026; Safety's MVR / PSP / CLH files are not re-posted.
 *
 * NOTHING IS DOWNLOADED. The photos are re-sent by their Telegram file ids,
 * which this bot captured — so a decision goes out in about a second. A post
 * whose pictures were sent "as files" is re-sent as documents (Telegram will
 * not mix the two in one album); a post with no picture is a text message.
 * At most ten pictures: Telegram's album limit.
 *
 * IN GENERAL, the bot asks Safety which driver a decision is about when it
 * could not tell — once, as a reply to Safety's message.
 */

const MAX_ALBUM = 10;

function log(text) {
  console.log(`[SAFETY APPROVALS] ${text}`);
}

/**
 * The pictures to send and how: photos as photos; only when there are none,
 * pictures sent as files, as documents.
 *
 * @param {{kind: string, fileId: string}[]} images  lib/safetyApprovals/bundle.js imagesOf
 */
function mediaFor(images = []) {
  const photos = images.filter((i) => i.kind === 'photo' && i.fileId);
  if (photos.length) return { type: 'photo', ids: photos.slice(0, MAX_ALBUM).map((p) => p.fileId) };
  const files = images.filter((i) => i.fileId);
  return { type: 'document', ids: files.slice(0, MAX_ALBUM).map((f) => f.fileId) };
}

/**
 * @returns {Promise<number[]>} the ids of the messages posted in the topic
 * @throws when Telegram refused — then nothing was posted
 */
async function postDecision(telegram, {
  chatId, topicId, caption, images = [],
}) {
  const thread = { message_thread_id: topicId };
  const { type, ids } = mediaFor(images);
  if (!ids.length) {
    const sent = await telegram.sendMessage(chatId, caption, {
      ...thread, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    });
    return [sent.message_id];
  }
  if (ids.length === 1) {
    const send = type === 'photo' ? telegram.sendPhoto.bind(telegram) : telegram.sendDocument.bind(telegram);
    const sent = await send(chatId, ids[0], { ...thread, caption, parse_mode: 'HTML' });
    return [sent.message_id];
  }
  // The caption on the first item is the one Telegram shows under the album.
  const media = ids.map((id, i) => ({ type, media: id, ...(i === 0 ? { caption, parse_mode: 'HTML' } : {}) }));
  const sent = await telegram.sendMediaGroup(chatId, media, thread);
  return (Array.isArray(sent) ? sent : []).map((m) => m.message_id);
}

const ASK = Object.freeze({
  which_driver: '❓ <b>Which driver is this about?</b>\nI could not tell from the conversation. '
    + 'Please reply to the driver\'s post with <b>#Approved</b> or <b>#NotApproved</b>.',
  which_of_team: '❓ <b>Which driver is this about?</b>\nThe post has more than one driver. '
    + 'Please write the name after the hashtag, e.g. <b>#Approved Darnell</b>, or "both".',
  unclear: '❓ <b>I could not tell which driver, or what was decided.</b>\n'
    + 'Please reply to the driver\'s post with <b>#Approved</b> or <b>#NotApproved</b>.',
  conflict: '❓ <b>Approved or not approved?</b>\nThe message carries both hashtags for the same driver. '
    + 'Please reply to the driver\'s post with just one of them.',
  post_not_seen: '❓ <b>I could not find the driver\'s post this answers.</b>\n'
    + 'Please reply to the recruiter\'s post (the one with the CDL) with <b>#Approved</b> or <b>#NotApproved</b>.',
});

/** Ask Safety, in the chat they wrote in, under their own message. Never throws. */
async function askSafety(telegram, {
  chatId, threadId = null, replyTo, reason,
}) {
  try {
    await telegram.sendMessage(chatId, ASK[reason] || ASK.which_driver, {
      ...(threadId ? { message_thread_id: threadId } : {}),
      reply_to_message_id: Number(replyTo),
      allow_sending_without_reply: true,
      parse_mode: 'HTML',
    });
    return true;
  } catch (err) {
    log(`could not ask Safety which driver (${String(err.message).slice(0, 120)})`);
    return false;
  }
}

module.exports = {
  postDecision,
  askSafety,
  mediaFor,
  ASK,
  MAX_ALBUM,
};
