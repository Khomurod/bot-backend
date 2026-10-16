'use strict';

/**
 * What the approvals topic is told, and where. Pure.
 *
 * THE CAPTION CARRIES NOTHING A MODEL WROTE. The status and the driver come
 * from a verified reading (lib/safetyApprovals/reading.js); the phone is the
 * one the recruiter typed; and Safety's reasons are Safety's own words, quoted
 * as they were written — a model's summary of why a driver was refused is not
 * something to post under Safety's name.
 *
 * Telegram allows 1,024 characters in a caption. Everything is HTML-escaped,
 * because every value here was typed by a person in a group chat.
 */

const CAPTION_LIMIT = 1024;

const STATUS_LINE = Object.freeze({
  approved: '✅ <b>APPROVED</b>',
  not_approved: '❌ <b>NOT APPROVED</b>',
});

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** -1001234567890 → 1234567890, the form t.me/c/ links use; null otherwise. */
function internalChatId(chatId) {
  const text = String(chatId ?? '').trim();
  return /^-100\d+$/.test(text) ? text.slice(4) : null;
}

/** A link that opens the recruiter's post, or null for a chat it cannot address. */
function postLink(chatId, messageId) {
  const internal = internalChatId(chatId);
  if (!internal || !Number.isInteger(Number(messageId))) return null;
  return `https://t.me/c/${internal}/${Number(messageId)}`;
}

/**
 * The caption for one driver's decision.
 *
 * @param {object} args
 * @param {'approved'|'not_approved'} args.decision
 * @param {string} args.name
 * @param {boolean} [args.nameFromCdl]   the name was read off the CDL photo
 * @param {string|null} args.phone        as the recruiter wrote it
 * @param {string|null} args.safetyNote   Safety's words, verbatim
 * @param {string|null} args.recruiterName
 * @param {string|null} args.safetyName
 * @param {string|null} args.link
 */
function buildCaption({
  decision, name, nameFromCdl = false, phone = null, safetyNote = null, recruiterName = null, safetyName = null,
  link = null,
}) {
  const head = [
    STATUS_LINE[decision],
    `<b>${escapeHtml(name)}</b>${nameFromCdl ? ' <i>(name read from the CDL)</i>' : ''}`,
  ];
  if (phone) head.push(`📞 ${escapeHtml(phone)}`);
  const tail = [];
  const people = [
    recruiterName ? `Recruiter: ${escapeHtml(recruiterName)}` : null,
    safetyName ? `Safety: ${escapeHtml(safetyName)}` : null,
  ].filter(Boolean).join(' · ');
  if (people) tail.push(`👤 ${people}`);
  if (link) tail.push(`<a href="${escapeHtml(link)}">Original post</a>`);

  const note = String(safetyNote || '').replace(/\s+/g, ' ').trim();
  const fixed = [...head, ...tail].join('\n');
  if (!note) return fixed.slice(0, CAPTION_LIMIT);

  // The note is the one part that can be long; it gives way to the rest.
  const frame = (text) => `💬 «${text}»`;
  const room = CAPTION_LIMIT - fixed.length - frame('').length - 1;
  let quoted = escapeHtml(note);
  if (quoted.length > room) {
    let cut = note;
    while (cut.length && escapeHtml(`${cut}…`).length > room) cut = cut.slice(0, -1);
    quoted = cut ? escapeHtml(`${cut.trimEnd()}…`) : '';
  }
  if (!quoted) return fixed.slice(0, CAPTION_LIMIT);
  return [...head, frame(quoted), ...tail].join('\n');
}

/**
 * Read the approvals topic from what an administrator pasted: the topic's
 * number, or a link to the topic or to any message in it
 * (https://t.me/c/1234567890/45 or https://t.me/c/1234567890/45/678 — the
 * topic is the first number after the chat).
 *
 * @returns {{topicId: number, chatId: string|null}|{error: string}}
 */
function parseTopicReference(input) {
  const text = String(input ?? '').trim();
  if (/^\d+$/.test(text)) {
    const topicId = Number(text);
    return topicId > 0 ? { topicId, chatId: null } : { error: 'The topic number must be positive.' };
  }
  const match = text.match(/^(?:https?:\/\/)?t\.me\/c\/(\d+)\/(\d+)(?:\/(\d+))?\/?(?:\?.*)?$/i);
  if (!match) {
    return { error: 'Paste the topic number, or a t.me/c/… link to the topic or to a message in it.' };
  }
  return { topicId: Number(match[2]), chatId: `-100${match[1]}` };
}

module.exports = {
  buildCaption,
  parseTopicReference,
  postLink,
  internalChatId,
  escapeHtml,
  CAPTION_LIMIT,
};
