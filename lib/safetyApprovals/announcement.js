'use strict';

/**
 * What the approvals topic is told, and where. Pure.
 *
 * THE DRIVER'S POST, AS THE RECRUITER SENT IT, WITH THE DECISION UNDER IT
 * (the owner's layout, 20 October 2026): the post's photos (the CDL), and as
 * their caption the recruiter's own words — job, full name, phone, experience
 * — then the decision and who made it:
 *
 *   Company Driver - 80 CPM
 *
 *   John Bolling
 *   3,5 yrs of exp
 *   +17049572114
 *   ━━━━━━━━━━━━━━━━━━
 *   ✅ APPROVED by Aubrey Davis
 *   📝 Reason: …                     ← only when Safety wrote one
 *   👤 Recruiter: Amelia Carter · 🔗 Original post
 *
 * Safety's MVR / PSP / Clearinghouse files are NOT re-posted here.
 *
 * NOTHING HERE WAS WRITTEN BY A MODEL. The words are the recruiter's,
 * verbatim (an SSN taken out, in case one was pasted), the status is Safety's
 * hashtag or a verified reading, the reason is Safety's own words. Everything
 * is HTML-escaped: it was all typed by people in a group chat. A caption is
 * at most 1,024 characters, so the recruiter's words give way first.
 */

const { stripSsn } = require('../hiringStages/redact');

const CAPTION_LIMIT = 1024;
const RULE = '━━━━━━━━━━━━━━━━━━';

const STATUS = Object.freeze({
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
 * @param {string} args.postText          the recruiter's words, as written
 * @param {string} args.name              the driver
 * @param {boolean} [args.nameInStatus]   a team post: say whose decision this is
 * @param {boolean} [args.nameFromCdl]    the name was read off the CDL photo
 * @param {string|null} [args.decidedBy]  the Safety person
 * @param {string|null} [args.reason]     Safety's words, verbatim
 * @param {string|null} [args.recruiterName]
 * @param {string|null} [args.link]
 */
function buildCaption({
  decision, postText = '', name, nameInStatus = false, nameFromCdl = false, decidedBy = null, reason = null,
  recruiterName = null, link = null,
}) {
  const who = nameInStatus ? ` — <b>${escapeHtml(name)}</b>` : '';
  const tail = [RULE, `${STATUS[decision]}${who}${decidedBy ? ` by ${escapeHtml(decidedBy)}` : ''}`];
  if (reason) tail.push(`📝 ${decision === 'not_approved' ? 'Reason' : 'Note'}: ${escapeHtml(reason)}`);
  const footer = [
    recruiterName ? `👤 Recruiter: ${escapeHtml(recruiterName)}` : null,
    link ? `🔗 <a href="${escapeHtml(link)}">Original post</a>` : null,
  ].filter(Boolean).join(' · ');
  if (footer) tail.push(footer);
  const end = tail.join('\n');

  const words = stripSsn(postText).trim();
  // No words in the post (or the name came off the CDL): the name leads.
  const lead = !words || nameFromCdl
    ? `👤 <b>${escapeHtml(name)}</b>${nameFromCdl ? ' <i>(name read from the CDL)</i>' : ''}`
    : null;
  const room = CAPTION_LIMIT - end.length - (lead ? lead.length + 1 : 0) - 1;
  let body = escapeHtml(words);
  if (body.length > room) {
    let cut = words;
    while (cut.length && escapeHtml(`${cut}…`).length > room) cut = cut.slice(0, -1);
    body = cut ? escapeHtml(`${cut.trimEnd()}…`) : '';
  }
  return [lead, body, end].filter(Boolean).join('\n');
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
  CAPTION_LIMIT,
  parseTopicReference,
  postLink,
  internalChatId,
  escapeHtml,
};
