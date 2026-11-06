'use strict';

/**
 * Videos in the hand-over PDF: a link to each one, and how long it is. Pure.
 *
 * THE OWNER, 6 November 2026: a video a driver sends of the truck goes into
 * the PDF as a LINK to its message in Telegram — never downloaded, never
 * stored. The person who receives the PDFs is in every driver group (the
 * owner's answer, the same day), so a private-group link opens for them.
 *
 * A link to a message exists only in a SUPERGROUP: its chat id is "-100"
 * followed by the number the link uses (`https://t.me/c/<that>/<message>`). A
 * basic group has no such link; the PDF then says which chat and when, so the
 * video can still be found.
 */

/** `https://t.me/c/3956955141/812` for a supergroup's message; null otherwise. */
function telegramMessageLink(chatId, messageId) {
  const chat = String(chatId ?? '');
  const id = Number(messageId);
  const m = /^-100(\d+)$/.exec(chat);
  if (!m || !Number.isInteger(id) || id <= 0) return null;
  return `https://t.me/c/${m[1]}/${id}`;
}

/** "0:35", "4:05", "1:02:03"; null when the length is not known. */
function durationText(seconds) {
  if (seconds === null || seconds === undefined || seconds === '') return null;
  const total = Number(seconds);
  if (!Number.isFinite(total) || total < 0) return null;
  const s = Math.round(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

module.exports = { telegramMessageLink, durationText };
