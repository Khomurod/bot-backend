'use strict';

/**
 * Is this Safety message a decision at all, and if it carries a hashtag, which
 * one? Pure.
 *
 * THE TEAM'S CONVENTION (owner, 20 October 2026): Safety marks a decision with
 * `#Approved` or `#NotApproved`, so no model has to read the conversation to
 * find one. A hashtag IS the decision — for the driver(s) it names, or the
 * post it answers.
 *
 * Without a hashtag, the words "approved" / "not approved" / "hire" still count, so a
 * forgotten hashtag never loses a decision; those are read by a model, as
 * before. A Safety message with neither ("on it", "CLH sent", a PDF) is not a
 * decision and costs nothing.
 *
 * A message may carry several hashtags — "#Approved Darnell #NotApproved
 * Calvin" for a team — so it is cut into SEGMENTS: each hashtag with the words
 * after it, up to the next one.
 */

/** "#Approved", "#approved", "#NotApproved", "#Not_Approved", "#not-approved", "# Approved". */
const HASHTAG = /#\s?(not[\s_-]?approved|approved)\b/gi;

/**
 * The words, without a hashtag: "approved", "not approved", "disapproved",
 * "unapproved", and — the owner's addition — "hire": "we can hire him",
 * "can't hire him".
 */
const KEYWORD = /\b(?:(?:not[\s_-]?|dis|un)?approved?|hire[ds]?)\b/i;
const DECISION_WORDS = /\b(?:not[\s_-]?|dis|un)?approved?\b/gi;

/**
 * A CONDITION is not a decision (owner, 27 November 2026). "PSP is clean, if
 * CLH is clean we can hire" says what Safety WILL decide, and on 27 November
 * a model read it as APPROVED. Without a hashtag, Safety's words with any of
 * these are left alone: nothing is posted and nothing is asked — the owner
 * chose silence. A hashtag is the team's explicit mark and still decides.
 */
const CONDITION = new RegExp([
  "\\b(?:if|unless|once|until|provided|assuming|pending|depends|depending)\\b",
  '\\bas long as\\b',
  '\\bon condition\\b',
  '(?:^|[^\\p{L}])(?:если|при условии|пока не)(?![\\p{L}])',
].join('|'), 'iu');

/** Safety's words carry a condition — "if CLH is clean", "once the drug test is back". */
function isConditional(text) {
  return CONDITION.test(String(text || ''));
}

function decisionOf(tag) {
  return /^not/i.test(tag.replace(/\s/g, '')) ? 'not_approved' : 'approved';
}

/**
 * @returns {{segments: {decision: string, text: string}[], hashtag: string|null,
 *   keyword: boolean, question: boolean}}
 *   `hashtag` is the one decision every hashtag agrees on, 'mixed' when they
 *   differ, or null when there is none.
 */
function readTrigger(text) {
  const source = String(text || '');
  const marks = [...source.matchAll(HASHTAG)];
  const segments = marks.map((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : source.length;
    return { decision: decisionOf(m[1]), text: source.slice(m.index + m[0].length, end).replace(/\s+/g, ' ').trim() };
  });
  const kinds = new Set(segments.map((s) => s.decision));
  return {
    segments,
    hashtag: kinds.size === 0 ? null : kinds.size === 1 ? [...kinds][0] : 'mixed',
    keyword: KEYWORD.test(source),
    question: source.includes('?'),
  };
}

/** Worth reading at all: a hashtag, or the words. */
function isDecisionMessage(text) {
  const t = readTrigger(text);
  return Boolean(t.hashtag) || t.keyword;
}

/**
 * Safety's own words beside the hashtag — the reason line on the card — with
 * the hashtag and the words "approved" / "not approved" taken out. Nothing
 * when that leaves nothing.
 */
function reasonFrom(text) {
  const words = String(text || '')
    .replace(HASHTAG, ' ')
    .replace(DECISION_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:–—-]+|[\s,;:–—-]+$/g, '')
    .trim();
  if (!words || !/\p{L}/u.test(words)) return null;
  return words.length > 300 ? `${words.slice(0, 297)}…` : words;
}

module.exports = {
  readTrigger, isDecisionMessage, isConditional, reasonFrom, HASHTAG, KEYWORD,
};
