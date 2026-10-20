'use strict';

/**
 * Which captured messages make up a recruiter's post, and which make up
 * Safety's answer to it. Pure: the rows come in, the decision comes out.
 *
 * A POST is the message Safety replied to, the rest of its album, and — only
 * when that leaves the post without words or without pictures — the same
 * recruiter's other non-reply messages sent within a few minutes of it. A
 * recruiter who sends the photos and then the names as two messages has still
 * made one post; a recruiter who posts two complete drivers in a row has made
 * two, and the second is not pulled into the first.
 *
 * A FORWARDED POST is the original author's. Safety sometimes forwards a
 * recruiter's post in pieces — the album with the name, then "old cdl" — so a
 * forwarded post also gathers the other messages forwarded from the SAME
 * author around it when it has no name in writing; never anything the
 * forwarder wrote themselves.
 *
 * SAFETY'S ANSWER is what the Safety people sent IN REPLY to any message of
 * the post (and the rest of a reply album). A message that is not a reply is
 * not an answer to anything, however close in time.
 */

const { isImageDocument } = require('./messageShape');
const { namesInPost } = require('./postDetails');

/** At most this many pictures are shown to the model and offered as the CDL. */
const MAX_POST_IMAGES = 6;

function byMessageId(a, b) {
  return a.messageId - b.messageId;
}

function uniqueMessages(rows) {
  const seen = new Map();
  for (const row of rows) if (row && !seen.has(row.messageId)) seen.set(row.messageId, row);
  return [...seen.values()].sort(byMessageId);
}

function imagesOf(row) {
  const photos = (row.photos || []).map((p) => ({
    kind: 'photo', fileId: p.file_id, mimeType: 'image/jpeg', fileName: null, size: p.file_size ?? null, messageId: row.messageId,
  }));
  const docs = (row.documents || []).filter(isImageDocument).map((d) => ({
    kind: 'document', fileId: d.file_id, mimeType: d.mime_type, fileName: d.file_name || null, size: d.file_size ?? null,
    messageId: row.messageId,
  }));
  return [...photos, ...docs];
}

/** Who a forwarded message is really from, as one comparable key; null when not forwarded. */
function originKey(row) {
  if (row.forwardedFromUserId) return `user:${row.forwardedFromUserId}`;
  return row.forwardedFromName ? `name:${row.forwardedFromName}` : null;
}

/** Does this post need its sender's neighbouring messages to be whole? */
function isIncomplete(rows) {
  const hasText = rows.some((r) => r.text);
  const hasImages = rows.some((r) => imagesOf(r).length);
  const forwardedWithoutName = Boolean(originKey(rows[0])) && !namesInPost(joinTexts(rows)).length;
  return { hasText, hasImages, incomplete: !hasText || !hasImages || forwardedWithoutName, forwardedWithoutName };
}

function joinTexts(rows) {
  return rows.map((r) => (r.text || '').trim()).filter(Boolean).join('\n\n');
}

/**
 * @param {object} replied       the message Safety replied to
 * @param {object[]} album       every item of its album (may be empty)
 * @param {object[]} neighbours  the recruiter's non-reply messages close in time
 */
function assemblePost(replied, album = [], neighbours = []) {
  let rows = uniqueMessages([replied, ...album]);
  const { hasText, hasImages, incomplete, forwardedWithoutName } = isIncomplete(rows);
  if (incomplete) {
    const origin = originKey(replied);
    // A forwarded post only gathers what was forwarded from the same author.
    const sameSender = neighbours.filter((n) => n.fromUserId === replied.fromUserId && !n.replyToMessageId
      && originKey(n) === origin);
    const wanted = sameSender.filter((n) => ((!hasText || forwardedWithoutName) && n.text)
      || (!hasImages && imagesOf(n).length));
    // The rest of any album a wanted neighbour belongs to comes with it.
    const groups = new Set(wanted.map((n) => n.mediaGroupId).filter(Boolean));
    rows = uniqueMessages([
      ...rows,
      ...wanted,
      ...sameSender.filter((n) => n.mediaGroupId && groups.has(n.mediaGroupId)),
    ]);
  }
  return {
    messageIds: rows.map((r) => r.messageId),
    // Safety may answer any item of an album; the post is known by its first.
    anchorId: rows[0].messageId,
    text: joinTexts(rows),
    images: rows.flatMap(imagesOf).slice(0, MAX_POST_IMAGES),
    recruiterName: replied.forwardedFromName || replied.fromName || null,
    recruiterUserId: replied.forwardedFromUserId || replied.fromUserId || null,
    forwarded: Boolean(originKey(replied)),
  };
}

/** @param {object[]} replies  the Safety people's replies to the post, any order */
function assembleSafety(replies = []) {
  const rows = uniqueMessages(replies);
  const documents = rows.flatMap((r) => (r.documents || []).map((d) => ({
    fileId: d.file_id, fileName: d.file_name || null, mimeType: d.mime_type || null, uniqueId: d.file_unique_id || null,
  })));
  const seen = new Set();
  const uniqueDocs = documents.filter((d) => {
    const key = d.uniqueId || d.fileId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const latest = rows.reduce((max, r) => {
    const at = new Date(r.editedAt || r.sentAt || 0).getTime();
    return Math.max(max, Number.isFinite(at) ? at : 0);
  }, 0);
  const names = [...new Set(rows.map((r) => r.fromName).filter(Boolean))];
  return {
    messageIds: rows.map((r) => r.messageId),
    text: joinTexts(rows),
    documents: uniqueDocs,
    fileNames: uniqueDocs.map((d) => d.fileName).filter(Boolean),
    latestAt: latest ? new Date(latest) : null,
    safetyName: names.join(', ') || null,
  };
}

module.exports = {
  isIncomplete,
  originKey,
  assemblePost,
  assembleSafety,
  imagesOf,
  MAX_POST_IMAGES,
};
