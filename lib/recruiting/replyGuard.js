'use strict';

/**
 * What Wenze is allowed to say to a candidate in a recruiter's name.
 *
 * Pure. Text and the approved corpus in, a verdict out. No model, no database,
 * no network — so the rule that governs a model is not itself decided by one.
 *
 * "AI MUST NEVER INVENT OR PROMISE CONDITIONS OUTSIDE APPROVED COMPANY
 * INFORMATION" is a sentence, and a sentence is not enforcement. This module is
 * the enforcement, and it works on the observation that an invented condition
 * is almost always a NUMBER: a rate, a mileage, a sign-on bonus, a home-time
 * interval, an age limit, a start date. Prose can be vague and harmless; "77
 * cents per mile" cannot. So:
 *
 *   EVERY NUMBER IN THE REPLY MUST ALREADY APPEAR IN SOMETHING A HUMAN
 *   APPROVED.
 *
 * The corpus is `recruiting_knowledge` — statements an administrator typed and
 * then confirmed — plus whatever the caller adds for the occasion (the time the
 * office opens, say). A number that is in neither means the model reached for
 * a figure nobody gave it, and the reply is refused whole. Not edited: refused.
 * A sentence with its rate silently removed is a worse answer than no answer,
 * and repairing a model's claim is how a wrong one survives review.
 *
 * DELIBERATELY NOT CONSULTED: the conversation itself. A candidate who writes
 * "I heard you pay 80 cpm" has put 80 into the thread, and a guard that
 * accepted numbers from context would let Wenze agree with it. The candidate is
 * not an approved source about the company's own terms.
 *
 * The second half is promises. A model asked to be helpful and to keep a
 * candidate warm will, sooner or later, say yes to something — grant an
 * exception, guarantee a truck, confirm a hire. Those are employment decisions
 * and they belong to a person. The patterns below refuse the GRANTING of an
 * exception while deliberately leaving the WORD "exception" usable, because the
 * approved answer to a candidate asking for one is that the recruiter can
 * discuss it during working hours.
 *
 * A refusal is not a failure of the feature. It is the feature: the candidate
 * gets the fixed, safe acknowledgement instead, and a person sees what was
 * refused.
 */

/** Two SMS segments. Longer than this is a wall of text on a phone. */
const MAX_LENGTH = 320;
const MIN_LENGTH = 12;

/**
 * Granting, guaranteeing, hiring, and speaking for the company's future.
 *
 * Each of these was chosen because it is a commitment a candidate could
 * reasonably hold the company to. "We are hiring" is fine and stays fine —
 * the patterns require a first-person commitment, not the topic.
 */
const FORBIDDEN = [
  {
    re: /\bguarantee\w*\b/i,
    why: 'guarantees something',
  },
  {
    re: /\b(?:i|we)\s+(?:can\s+|will\s+|could\s+|would\s+)?promise\b|\bi\s+promise\b|\byou\s+have\s+my\s+word\b/i,
    why: 'makes a promise',
  },
  {
    re: /\b(?:i|we)\s+(?:can|could|will|would|'ll)\s+(?:definitely\s+|certainly\s+|absolutely\s+)?(?:approve|waive|authorri?ze|authorise|authorize|make\s+an\s+exception|give\s+you\s+an\s+exception|get\s+you\s+an\s+exception|override)\b/i,
    why: 'grants an exception, which is a recruiter\'s decision',
  },
  {
    re: /\byou(?:'re|\s+are)\s+(?:hired|approved|accepted|qualified)\b|\bwe(?:'re|\s+are)\s+hiring\s+you\b|\bconsider\s+yourself\s+hired\b/i,
    why: 'makes a hiring decision',
  },
  {
    re: /\b(?:i|we)\s+(?:can|could|will|would|'ll)\s+(?:offer|get)\s+you\s+(?:a\s+|an\s+|the\s+)?(?:job|position|contract|truck|route|raise)\b/i,
    why: 'offers a position or an asset',
  },
  {
    re: /\bstart(?:ing)?\s+(?:on\s+)?monday\b|\byour\s+start\s+date\s+is\b|\bcome\s+in\s+(?:tomorrow|today)\s+to\s+start\b/i,
    why: 'sets a start date',
  },
  {
    re: /\bno\s+(?:experience|cdl|license|licence)\s+(?:is\s+)?(?:needed|required|necessary)\b/i,
    why: 'waives a hiring requirement',
  },
];

/** A link or an address is a second channel nobody vetted. */
const CONTACT_LEAKS = [
  { re: /https?:\/\/\S+/i, why: 'contains a link' },
  { re: /\bwww\.\S+/i, why: 'contains a link' },
  { re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/, why: 'contains an email address' },
];

/** Markup a phone shows literally, so it reads as a glitch rather than a message. */
const MARKUP = /[*_`#]{2,}|^\s*[-*]\s+|\|\s*-{3,}/m;

/**
 * Every number in a piece of text, normalised so that `$0.77`, `0.77` and
 * `.77` are the same claim and `2,500` is the same as `2500`.
 *
 * Trailing zeros are trimmed after a decimal point so `77.0` matches `77`.
 */
function extractNumbers(text) {
  const found = new Set();
  const matches = String(text || '').matchAll(/\d[\d,]*(?:\.\d+)?|\.\d+/g);
  for (const match of matches) {
    const raw = match[0].replace(/,/g, '');
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    found.add(normaliseNumber(value));
  }
  return found;
}

/** A number as a comparable string: 77, 0.77, 2500. */
function normaliseNumber(value) {
  // toFixed(4) then trim: avoids 0.1+0.2 style representations reaching the set
  // as different strings for the same figure.
  return String(Number(value.toFixed(4)));
}

/**
 * Numbers that need no approval because they are not claims about the offer.
 *
 * Kept very short on purpose. Every entry here is a hole, so each one has to
 * earn its place: 1 and 2 appear in ordinary phrasing ("one of our recruiters",
 * "a couple"), and 24/7 is a figure of speech about availability rather than a
 * term of employment.
 */
const UNCLAIMED_NUMBERS = new Set(['1', '2', '24', '7']);

/**
 * @param {string} reply            what the model produced
 * @param {object} context
 * @param {string[]} context.approvedText  confirmed knowledge statements
 * @param {Array<string|number>} [context.extraApproved]
 *        figures this particular reply is allowed to use — the time the office
 *        opens, for instance — because they came from the system, not the model
 * @returns {{ok: true, text: string} | {ok: false, reason: string, detail?: string}}
 */
function checkReply(reply, { approvedText = [], extraApproved = [] } = {}) {
  const text = String(reply || '').replace(/\s+/g, ' ').trim();

  if (text.length < MIN_LENGTH) {
    return { ok: false, reason: 'too_short', detail: 'shorter than a real answer' };
  }
  if (text.length > MAX_LENGTH) {
    return { ok: false, reason: 'too_long', detail: `${text.length} characters; the limit is ${MAX_LENGTH}` };
  }
  if (MARKUP.test(text)) {
    return { ok: false, reason: 'formatting', detail: 'contains markdown, which a phone shows literally' };
  }

  for (const { re, why } of CONTACT_LEAKS) {
    if (re.test(text)) return { ok: false, reason: 'contact_leak', detail: why };
  }

  for (const { re, why } of FORBIDDEN) {
    if (re.test(text)) return { ok: false, reason: 'commitment', detail: why };
  }

  const approved = new Set(UNCLAIMED_NUMBERS);
  for (const statement of approvedText || []) {
    for (const n of extractNumbers(statement)) approved.add(n);
  }
  for (const extra of extraApproved || []) {
    for (const n of extractNumbers(String(extra))) approved.add(n);
  }

  const unsourced = [...extractNumbers(text)].filter((n) => !approved.has(n));
  if (unsourced.length) {
    return {
      ok: false,
      reason: 'unapproved_figure',
      // The figure itself, so the person reviewing the refusal can decide
      // whether it was a hallucination or a fact nobody has taught Wenze yet.
      detail: `used ${unsourced.join(', ')}, which no approved statement contains`,
    };
  }

  return { ok: true, text };
}

module.exports = {
  MAX_LENGTH,
  MIN_LENGTH,
  FORBIDDEN,
  UNCLAIMED_NUMBERS,
  extractNumbers,
  normaliseNumber,
  checkReply,
};
