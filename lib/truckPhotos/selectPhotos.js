'use strict';

/**
 * Which of the remembered photos go into this PDF. Pure.
 *
 * THE OWNER'S RULE (6 November 2026):
 *
 *   - A REPLY TO A PHOTO is about that photo: its whole album, and the
 *     photos around it — from `lookbackHours` before the photo to
 *     `lookbackHours` after it, and never past the word (the owner, 6 November
 *     2026: a reply to a week-old photo is about that day, not the whole week).
 *     A photo whose caption IS the word is its own anchor, so the rest of its
 *     album counts even though Telegram numbers those items after it.
 *   - A PLAIN WORD is about the last `lookbackHours` (3 by default).
 *   - From ANY sender — the driver and the fleet manager both photograph the
 *     truck. The bot's own pictures are never remembered in the first place.
 *   - VIDEOS are chosen by the same rules (the PDF lists them as links); the
 *     caller tells them apart by `kind`.
 *   - PHOTOS AFTER THE WORD ARE IGNORED. "After" is Telegram's message order in
 *     the chat, which is exact where a timestamp to the second is not. A new
 *     word makes a new PDF.
 *   - NEVER TWICE. A photo already sent in an earlier PDF (`reportId`) is left
 *     out, and the same picture forwarded again (one `fileUniqueId`) is in once.
 *
 * In the order they were sent: time, then message order.
 */

const HOUR_MS = 60 * 60 * 1000;

function timeOf(value) {
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function byTimeThenMessage(a, b) {
  const t = (timeOf(a.sentAt) ?? 0) - (timeOf(b.sentAt) ?? 0);
  return t !== 0 ? t : Number(a.messageId) - Number(b.messageId);
}

/** Where the window starts: `lookbackHours` before the anchor (or the word). */
function windowStart({ trigger, anchor = null, lookbackHours }) {
  const triggerAt = timeOf(trigger?.sentAt) ?? Date.now();
  const anchorAt = anchor ? (timeOf(anchor.sentAt) ?? triggerAt) : triggerAt;
  const hours = Number(lookbackHours) > 0 ? Number(lookbackHours) : 3;
  return new Date(Math.min(anchorAt, triggerAt) - hours * HOUR_MS);
}

/**
 * Where the window ends: the word — or, for a reply to a photo, `lookbackHours`
 * after that photo when that is earlier than the word.
 */
function windowEnd({ trigger, anchor = null, lookbackHours }) {
  const triggerAt = timeOf(trigger?.sentAt) ?? Date.now();
  if (!anchor) return new Date(triggerAt);
  const anchorAt = timeOf(anchor.sentAt) ?? triggerAt;
  const hours = Number(lookbackHours) > 0 ? Number(lookbackHours) : 3;
  return new Date(Math.min(anchorAt + hours * HOUR_MS, triggerAt));
}

/**
 * @param {object} args
 * @param {Array<{id, messageId, mediaGroupId, fileUniqueId, sentAt, reportId}>} args.photos
 *   the chat's remembered photos (a superset is fine)
 * @param {{messageId:number, sentAt:Date|string}} args.trigger  the word
 * @param {{messageId:number, mediaGroupId:?string, sentAt:Date|string}|null} [args.anchor]
 *   the photo replied to, or the word itself when it is a captioned photo
 * @param {number} args.lookbackHours
 * @returns {{photos: Array, alreadySent: number, duplicates: number, from: Date, until: Date}}
 */
function selectPhotos({ photos = [], trigger, anchor = null, lookbackHours = 3 }) {
  const from = windowStart({ trigger, anchor, lookbackHours });
  const fromMs = from.getTime();
  const until = windowEnd({ trigger, anchor, lookbackHours });
  const untilMs = until.getTime();
  const triggerMessageId = Number(trigger?.messageId);

  const inAnchorAlbum = (p) => Boolean(anchor) && (
    Number(p.messageId) === Number(anchor.messageId)
    || (anchor.mediaGroupId != null && p.mediaGroupId != null && String(p.mediaGroupId) === String(anchor.mediaGroupId))
  );
  const inWindow = (p) => {
    const at = timeOf(p.sentAt);
    return at !== null && at >= fromMs && at <= untilMs && Number(p.messageId) <= triggerMessageId;
  };

  const candidates = photos.filter((p) => p && (inAnchorAlbum(p) || inWindow(p))).sort(byTimeThenMessage);

  let alreadySent = 0;
  let duplicates = 0;
  const seen = new Set();
  const selected = [];
  for (const photo of candidates) {
    if (photo.reportId !== null && photo.reportId !== undefined) { alreadySent += 1; continue; }
    const key = photo.fileUniqueId ? `u:${photo.fileUniqueId}` : `m:${photo.messageId}`;
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);
    selected.push(photo);
  }
  return {
    photos: selected, alreadySent, duplicates, from, until,
  };
}

module.exports = { selectPhotos, windowStart, windowEnd };
