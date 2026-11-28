'use strict';

/**
 * Claude deciding a HARD Safety decision from the whole conversation (owner,
 * 28 November 2026). PURE: the prompt, and the check of the answer.
 *
 * THE CASE. A team post, two drivers. Safety refused one by hashtag, then sent
 * the other's PSP / MVR / CLH ("ANTHONY MARTEZ JOHNSON psp.pdf", …) with "but
 * we can hire him". A person reading the group knows who "him" is; the rules
 * cannot, and the bot asked Safety — twice. The rules still decide what they
 * can (a hashtag naming one driver, the words naming one); what they cannot
 * now goes to Claude with what a person would look at: the recruiter's post,
 * every message in its reply chain (who wrote it, what, which files), and
 * what the bot has already posted for each driver.
 *
 * WHAT CLAUDE MAY DO, AND WHAT IS CHECKED HERE:
 *   - pick drivers ONLY by their label in the post's list — it cannot name
 *     anyone the recruiter did not post;
 *   - with a hashtag, only say WHO: the status is the hashtag's;
 *   - without one, say approved / not approved, never on Safety's words that
 *     refuse, ask, or set a condition (the condition never reaches it);
 *   - quote Safety's own words (or file names) for each decision — a quote
 *     that is not there drops the decision;
 *   - say "unclear" — and only then is Safety asked.
 * Its answer is never shown: the post is the recruiter's words and Safety's
 * status, marked "read by AI" so Safety knows to glance at it.
 */

const { NEGATIVE } = require('./reading');
const { stripSsn } = require('../hiringStages/redact');

const LABELS = 'ABCDEFGH';
const MAX_LINE = 400;

/** The post's drivers as a closed list: A, B, … */
function labelDrivers(candidates) {
  return (candidates || []).slice(0, LABELS.length).map((c, i) => ({ ...c, label: LABELS[i] }));
}

function oneLine(text) {
  const words = stripSsn(String(text || '')).replace(/\s+/g, ' ').trim();
  return words.length > MAX_LINE ? `${words.slice(0, MAX_LINE - 1)}…` : words;
}

/** One message as a line of the transcript: who, which role, what, which files. */
function messageLine(row, { safetyIds, postIds, decisionIds }) {
  const role = safetyIds.includes(String(row.fromUserId)) ? 'SAFETY' : 'recruiter/other';
  const files = (row.documents || []).map((d) => d.file_name).filter(Boolean);
  const parts = [
    `#${row.messageId}`,
    row.replyToMessageId ? `(reply to #${row.replyToMessageId})` : null,
    `${row.fromName || 'someone'} [${role}]:`,
    oneLine(row.text) || null,
    files.length ? `[files: ${files.join(', ')}]` : null,
    row.photos?.length ? `[${row.photos.length} photo(s)]` : null,
    postIds.has(row.messageId) ? '<- THE RECRUITER\'S POST' : null,
    decisionIds.has(row.messageId) ? '<- THE MESSAGE TO DECIDE' : null,
  ];
  return parts.filter(Boolean).join(' ');
}

const SYSTEM = [
  'You read a trucking company\'s recruiting group chat. A recruiter posted one or more driver',
  'candidates. The Safety officer checks them and decides whether each one can be hired.',
  'Decide what THE MESSAGE TO DECIDE (written by Safety) decides, using the whole conversation',
  'for context: who it is about, as a person reading the chat would understand it.',
  '',
  'Rules:',
  '- Refer to drivers ONLY by their label from the list (A, B, ...). Never anyone else.',
  '- "approved": Safety clearly says the company can hire them / approves them.',
  '- "not_approved": Safety clearly refuses them.',
  '- "unclear": a question, a condition ("if ..."), waiting for documents, or you are not sure.',
  '  When in doubt, it is unclear. Do not decide for a driver the message is not about.',
  '- If the message has a hashtag (#Approved / #NotApproved), that IS the decision: you only say',
  '  which driver(s) it is about.',
  '- A driver the bot already decided keeps that unless THE MESSAGE TO DECIDE changes it.',
  '- "evidence": copy Safety\'s exact words (or a file name) that show who and what. Short.',
  '',
  'Answer with JSON only:',
  '{"decisions":[{"driver":"A","decision":"approved|not_approved|unclear","evidence":"exact words"}],',
  ' "confidence": 0-100}',
].join('\n');

const STATUS_WORD = { approved: 'APPROVED', not_approved: 'NOT APPROVED', withdrawn: 'WITHDRAWN' };

/**
 * @param {object} args
 * @param {object[]} args.drivers       labelDrivers()
 * @param {object[]} args.decided       the bot's latest decision per driver: { driverKey, decision }
 * @param {object[]} args.conversation  captured messages, oldest first
 * @param {object[]} args.decisionRows  the message to decide (an album: every item)
 * @param {string[]} args.postIds       the recruiter's post's message ids
 * @param {string[]} args.safetyIds
 * @param {string|null} args.hashtag    'approved' | 'not_approved' | 'mixed' | null
 */
function buildJudgePrompt({
  drivers, decided = [], conversation, decisionRows, postIds, safetyIds, hashtag = null,
}) {
  const said = new Map(decided.map((d) => [d.driverKey, d.decision]));
  const list = drivers.map((d) => {
    const already = said.get(d.key);
    return `${d.label}: ${d.name}${already ? ` (the bot already posted: ${STATUS_WORD[already] || already})` : ''}`;
  });
  const decisionIds = new Set(decisionRows.map((r) => r.messageId));
  const seen = new Set();
  const rows = [...conversation, ...decisionRows].filter((r) => {
    if (seen.has(r.messageId)) return false;
    seen.add(r.messageId);
    return true;
  }).sort((a, b) => a.messageId - b.messageId);
  const ctx = { safetyIds: safetyIds.map(String), postIds: new Set(postIds.map(Number)), decisionIds };
  const userText = [
    '<drivers>', ...list, '</drivers>',
    '<conversation>', ...rows.map((r) => messageLine(r, ctx)), '</conversation>',
    `<hashtag>${hashtag || 'none'}</hashtag>`,
  ].join('\n');
  return { systemText: SYSTEM, userText };
}

function norm(text) {
  return String(text || '').toLowerCase().replace(/["'“”‘’`]/g, '').replace(/\s+/g, ' ').trim();
}

/** The shape the model must answer in (the router's `validate`). */
function validateJudgement(parsed) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.decisions)) {
    return { message: 'expected {"decisions": [...]}' };
  }
  return null;
}

/**
 * Keep only what the conversation proves.
 *
 * @param {object} parsed            the model's answer
 * @param {object} ctx
 * @param {object[]} ctx.drivers     labelDrivers()
 * @param {string|null} ctx.hashtag  the message's hashtag decision
 * @param {string} ctx.decisionText  Safety's words in the message to decide
 * @param {string[]} ctx.safetyWords everything Safety wrote, and their file names
 * @returns {{decisions: object[], dropped: object[]}}
 */
function verifyJudgement(parsed, {
  drivers, hashtag = null, decisionText = '', safetyWords = [],
}) {
  const dropped = [];
  const byLabel = new Map(drivers.map((d) => [d.label, d]));
  const allowed = hashtag === 'mixed' ? ['approved', 'not_approved'] : (hashtag ? [hashtag] : ['approved', 'not_approved']);
  const haystack = norm(safetyWords.join('\n'));
  const chosen = new Map();
  for (const raw of Array.isArray(parsed?.decisions) ? parsed.decisions : []) {
    const driver = byLabel.get(String(raw?.driver || '').trim().toUpperCase());
    const decision = String(raw?.decision || '').toLowerCase();
    if (!driver) { dropped.push({ why: 'not_a_listed_driver' }); continue; }
    if (decision === 'unclear') { dropped.push({ name: driver.name, why: 'unclear' }); continue; }
    if (!allowed.includes(decision)) { dropped.push({ name: driver.name, why: 'not_the_hashtag' }); continue; }
    const evidence = norm(raw?.evidence);
    if (evidence.length < 3 || !haystack.includes(evidence)) {
      dropped.push({ name: driver.name, why: 'evidence_not_in_safety_words' });
      continue;
    }
    if (!hashtag && decision === 'approved' && (NEGATIVE.test(decisionText) || decisionText.includes('?'))) {
      dropped.push({ name: driver.name, why: 'approval_with_refusal_or_question' });
      continue;
    }
    const held = chosen.get(driver.key);
    if (held && held.decision !== decision) {
      chosen.set(driver.key, { ...held, conflict: true });
      continue;
    }
    chosen.set(driver.key, { key: driver.key, name: driver.name, decision, evidence: raw.evidence });
  }
  const decisions = [];
  for (const item of chosen.values()) {
    if (item.conflict) dropped.push({ name: item.name, why: 'conflicting_decisions' });
    else decisions.push(item);
  }
  return { decisions, dropped };
}

module.exports = {
  SYSTEM, labelDrivers, buildJudgePrompt, validateJudgement, verifyJudgement, messageLine,
};
