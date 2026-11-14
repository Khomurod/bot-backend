'use strict';

/**
 * One candidate's conversation in the recruiting group, as the model reads it
 * and as the verifier checks it. Pure.
 *
 * A CONVERSATION IS A REPLY TREE. A recruiter posts a candidate (an album of
 * the CDL and medical card with the name and phone as a caption); Safety and
 * the recruiters answer by REPLYING to it, or to one of its replies: "CLH
 * sent" → "Done" → "CLEAN". Everything that leads back to one post by replies
 * is that post's conversation (database/hiringStages/threads.js collects it).
 *
 * Every line is labelled with WHO said it — Safety (the people named in
 * Settings) or a recruiter — because "approved" means one thing from Safety
 * and nothing from a recruiter asking whether it is.
 */

const { redactForAi, extractPhones } = require('./redact');
const { readTrigger } = require('../safetyApprovals/trigger');
const { isImageDocument } = require('../safetyApprovals/messageShape');

/** At most this many messages are shown: the newest are the ones that move a stage. */
const MAX_LINES = 40;
const MAX_LINE_CHARS = 600;

function roleOf(message, safetyUserIds) {
  return safetyUserIds.includes(String(message.fromUserId)) ? 'Safety' : 'Recruiter';
}

function fileNamesOf(message) {
  return (message.documents || []).map((d) => d.file_name).filter(Boolean);
}

/** The candidate post: the root message and the other items of its album. */
function postMessages(messages, rootMessageId) {
  const root = messages.find((m) => m.messageId === Number(rootMessageId));
  if (!root) return [];
  if (!root.mediaGroupId) return [root];
  return messages.filter((m) => m.mediaGroupId === root.mediaGroupId);
}

/** The words of the candidate post, verbatim (NOT redacted — this is for matching). */
function postText(messages, rootMessageId) {
  return postMessages(messages, rootMessageId).map((m) => m.text).filter(Boolean).join('\n');
}

/**
 * The lines the model reads, oldest first, redacted. Each line is
 * `[n] Safety (Name): words [files: a.pdf] [photo]`.
 */
function buildTranscript(messages, { rootMessageId, safetyUserIds = [] }) {
  const postIds = new Set(postMessages(messages, rootMessageId).map((m) => m.messageId));
  const ordered = [...messages].sort((a, b) => a.messageId - b.messageId);
  const lines = ordered.map((m) => {
    const who = postIds.has(m.messageId) ? 'Recruiter post' : roleOf(m, safetyUserIds);
    const name = m.fromName ? ` (${m.fromName})` : '';
    const words = m.text ? redactForAi(m.text).replace(/\s+/g, ' ').trim().slice(0, MAX_LINE_CHARS) : '';
    const files = fileNamesOf(m);
    const extras = [
      files.length ? `[files: ${files.join(', ')}]` : '',
      m.photos?.length ? '[photo]' : '',
    ].filter(Boolean).join(' ');
    return { who: `${who}${name}`, body: [words, extras].filter(Boolean).join(' ') };
  }).filter((line) => line.body);
  const kept = lines.length > MAX_LINES
    ? [lines[0], ...lines.slice(lines.length - (MAX_LINES - 1))]
    : lines;
  return kept.map((line, i) => `[${i + 1}] ${line.who}: ${line.body}`).join('\n');
}

/**
 * ONLY A CANDIDATE POST IS READ: one carrying a picture (the CDL) or a phone
 * number to reach the driver on. "The driver is there" and "office is
 * closed" are not. Takes the post's rows, or a post assembled by
 * lib/safetyApprovals/bundle.js (`images`, `text`) — one rule for both.
 */
function isCandidatePost(post) {
  if (!Array.isArray(post)) return (post?.images?.length || 0) > 0 || extractPhones(post?.text || '').length > 0;
  return post.some((m) => m.photos?.length || (m.documents || []).some(isImageDocument)
    || extractPhones(m.text || '').length > 0);
}

/** Has anybody answered the post yet? A lone post moves nothing. */
function hasReplies(messages, rootMessageId) {
  const postIds = new Set(postMessages(messages, rootMessageId).map((m) => m.messageId));
  return messages.some((m) => !postIds.has(m.messageId));
}

/**
 * Phone numbers a recruiter wrote in the conversation, the post's first. Safety
 * does not type candidates' numbers; a recruiter's later "tel number; …" does.
 * `post` replaces the post's words when the post was assembled with its
 * sender's neighbouring messages (services/hiringStages/requested.js).
 */
function candidatePhones(messages, { rootMessageId, safetyUserIds = [], post: assembled = null }) {
  const post = assembled ?? postText(messages, rootMessageId);
  const rest = messages
    .filter((m) => roleOf(m, safetyUserIds) === 'Recruiter')
    .map((m) => m.text || '')
    .join('\n');
  return [...new Set([...extractPhones(post), ...extractPhones(rest)])].slice(0, 3);
}

/**
 * What Safety's people typed in the conversation, oldest first — the words
 * themselves, never a model's reading of them. The post is the recruiter's,
 * even when Safety forwarded it, so it is left out.
 */
function safetyTexts(messages, { rootMessageId, safetyUserIds = [] }) {
  const postIds = new Set(postMessages(messages, rootMessageId).map((m) => m.messageId));
  return [...messages]
    .sort((a, b) => a.messageId - b.messageId)
    .filter((m) => !postIds.has(m.messageId) && roleOf(m, safetyUserIds) === 'Safety' && m.text)
    .map((m) => m.text);
}

/**
 * Did Safety reject the candidate, by RULE: Safety's newest hashtag decision
 * in the conversation is `#NotApproved` (lib/safetyApprovals/trigger.js). A
 * later `#Approved` undoes an earlier one; mixed hashtags (a team) decide
 * nothing here.
 */
function safetyRejected(messages, opts) {
  const decisions = safetyTexts(messages, opts).map((text) => readTrigger(text).hashtag).filter(Boolean);
  return decisions.at(-1) === 'not_approved';
}

/**
 * Every word of the conversation, lower-cased with spacing collapsed — what
 * evidence is checked against. Both as written and as the model saw it, so a
 * quote that crosses a "[phone]" marker still matches.
 */
function searchableText(messages) {
  const raw = messages.flatMap((m) => [m.text || '', ...fileNamesOf(m)]);
  return [...raw, ...raw.map(redactForAi)]
    .join('\n')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

module.exports = {
  MAX_LINES,
  postMessages,
  postText,
  buildTranscript,
  isCandidatePost,
  hasReplies,
  candidatePhones,
  safetyTexts,
  safetyRejected,
  searchableText,
};
