'use strict';

/**
 * Safety answering the bot's own post in their own words, read by Claude
 * (owner, 28 November 2026: "not only 'not yet' — let it understand plain
 * language"). PURE: the prompt and the check of the answer.
 *
 * The clear phrases still need no model (lib/safetyApprovals/withdrawal.js),
 * and a bare "ok" / "thanks" / 👍 is not even sent. Anything else is read into
 * ONE of a closed list, about the ONE driver that post is about:
 *
 *   withdraw      it was not Safety's decision (yet) — the post is marked
 *   approved      Safety now says this driver can be hired
 *   not_approved  Safety now says this driver cannot
 *   none          a comment, a thank-you, a question — nothing changes
 *
 * Checked here, not trusted: the evidence must be Safety's own words; an
 * approval beside a refusal, a question or a condition is none; the same
 * decision the post already shows is none.
 */

const { NEGATIVE } = require('./reading');
const { isConditional } = require('./trigger');

const ACTIONS = Object.freeze(['withdraw', 'approved', 'not_approved', 'none']);

/** "ok", "thanks!", "👍", "noted": an acknowledgement, never worth a model. */
const ACKNOWLEDGEMENT = /^(?:ok(?:ay)?|k|thanks?(?: you)?|thx|ty|noted|got it|great|good|cool|perfect|sure|yes|yep|👍|🙏|✅|👌|🔥|💯)[\s.!]*$/iu;

function isAcknowledgement(text) {
  const words = String(text || '').trim();
  if (!words) return true;
  if (!/\p{L}/u.test(words)) return true; // emoji and punctuation only
  return ACKNOWLEDGEMENT.test(words);
}

const STATUS_WORD = { approved: 'APPROVED', not_approved: 'NOT APPROVED', withdrawn: 'WITHDRAWN (not decided yet)' };

const SYSTEM = [
  'You read a trucking company\'s recruiting group chat. The bot posted a hire decision about ONE',
  'driver, and the Safety officer replied to that post. Say what Safety\'s reply means for THIS',
  'driver\'s hire decision.',
  '',
  'Choose exactly one action:',
  '- "withdraw": Safety says the posted decision is not theirs, not made yet, wrong or a mistake.',
  '- "approved": Safety clearly says this driver CAN be hired now.',
  '- "not_approved": Safety clearly says this driver can NOT be hired.',
  '- "none": anything else - a comment, thanks, a question, a condition ("if ..."), other news.',
  'When in doubt, "none".',
  '"evidence": copy Safety\'s exact words that show it. Short.',
  '',
  'Answer with JSON only: {"action":"withdraw|approved|not_approved|none","evidence":"exact words","confidence":0-100}',
].join('\n');

/**
 * @param {object} args
 * @param {string} args.driverName
 * @param {string} args.posted     the post's decision: approved | not_approved | withdrawn
 * @param {string} args.postText   the recruiter's words
 * @param {string} args.replyText  Safety's reply
 */
function buildBotPostPrompt({
  driverName, posted, postText, replyText,
}) {
  const fence = (tag, text) => `<${tag}>\n${String(text || '').replace(new RegExp(`</?${tag}>`, 'gi'), '')}\n</${tag}>`;
  const userText = [
    fence('driver', driverName),
    fence('bot_posted', STATUS_WORD[posted] || posted),
    fence('recruiter_post', postText || '(photos only)'),
    fence('safety_reply', replyText),
  ].join('\n');
  return { systemText: SYSTEM, userText };
}

function validateBotPostReading(parsed) {
  if (!parsed || typeof parsed !== 'object' || !ACTIONS.includes(String(parsed.action || '').toLowerCase())) {
    return { message: `expected {"action": one of ${ACTIONS.join(', ')}}` };
  }
  return null;
}

function norm(text) {
  return String(text || '').toLowerCase().replace(/["'“”‘’`]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {object} parsed  the model's answer
 * @param {object} ctx     { replyText, posted }
 * @returns {{action: string, why?: string, evidence?: string}}
 */
function verifyBotPostReading(parsed, { replyText, posted }) {
  const action = String(parsed?.action || '').toLowerCase();
  if (!ACTIONS.includes(action) || action === 'none') return { action: 'none' };
  const evidence = norm(parsed.evidence);
  if (evidence.length < 2 || !norm(replyText).includes(evidence)) return { action: 'none', why: 'evidence_not_in_reply' };
  if (action === 'approved' && (isConditional(replyText) || NEGATIVE.test(replyText) || replyText.includes('?'))) {
    return { action: 'none', why: 'approval_with_condition_refusal_or_question' };
  }
  if (action === posted || (action === 'withdraw' && posted === 'withdrawn')) return { action: 'none', why: 'already_says_so' };
  return { action, evidence: parsed.evidence };
}

module.exports = {
  ACTIONS, isAcknowledgement, buildBotPostPrompt, validateBotPostReading, verifyBotPostReading,
};
