'use strict';

/**
 * Did somebody REPORT that a thing happened, or ask for it? PURE.
 *
 * ONE PLACE, BECAUSE THE MISTAKE IS THE SAME MISTAKE. A void and a replacement
 * are different events, but the sentence around them fails in exactly one way:
 *
 *     "should we void this?"            — a question. Nothing happened.
 *     "please replace 1491583146"       — a request. Nothing happened YET.
 *     "working on it"                   — still nothing.
 *     "voided"                          — now something happened.
 *
 * Reading the subject word ("void", "replace") and stopping there turns all
 * four into the same answer. The word says WHAT is being discussed; the grammar
 * around it says WHETHER it happened. This module answers only the second half,
 * and it knows nothing about money — which is why both callers can share it
 * without either one inheriting the other's rules.
 *
 * THE ORDER IS THE SAFETY PROPERTY. Each test beats the ones below it, so
 * "we should not cancel that one" is negated rather than completed, and
 * "can you cancel it" is a question rather than an instruction. `plain` means
 * no marker at all — a bare statement — and what that MEANS is the caller's
 * decision, because a bare "void this" is an instruction while a bare
 * "replacement code: 123" is a report.
 */

const MODALITY = Object.freeze({
  NEGATED: 'negated',
  QUESTION: 'question',
  IN_PROGRESS: 'in_progress',
  REQUEST: 'request',
  COMPLETED: 'completed',
  PLAIN: 'plain',
});

/**
 * A question is never a completed action, whatever else it says.
 *
 * `do|does|did` deliberately do NOT take `it`: "please do it now" is an order,
 * not a question, and reading it as one put the wrong sentence on the screen
 * beside a real message. The answer was the same either way — both a question
 * and a request mean nothing has happened — so this changes an explanation, not
 * a decision. A genuine "did it get voided?" still matches on its question mark.
 */
const QUESTION = /\?\s*$|\b(should|shall|can|could|are|is)\s+(we|i|you|they|it)\b|\b(do|does|did)\s+(we|i|you|they)\b|\bwhat about\b/i;

/** Asking for it to happen. Still not it happening. */
const REQUEST = /\b(please|pls|plz|need(?:s)?\s+to|needed|want\s+to|have\s+to|must|let'?s|lets|can you|could you|going to|gonna|will)\b/i;

/** Work in progress reported as such. */
const IN_PROGRESS = /\b(working on it|on it|in progress|doing it|will do|trying|attempting)\b/i;

/** Plainly done. A past participle, or an explicit completion word beside it. */
const COMPLETED = /\b(voided|cancelled|canceled|revoked|killed|done|completed|sorted)\b/i;

/** Said about somebody else's future action, or explicitly refused. */
const NEGATED = /\b(not|never|don'?t|do not|dont|no need|nevermind|never mind)\b/i;

/**
 * @returns `{ modality, reason }` — `reason` is written for a person to read on
 *   the screen, so it explains the grammar rather than naming the regex.
 */
function classifyModality(text) {
  const source = String(text || '');
  if (NEGATED.test(source)) return { modality: MODALITY.NEGATED, reason: 'the statement is negated' };
  if (QUESTION.test(source)) return { modality: MODALITY.QUESTION, reason: 'asked as a question, so nothing has happened yet' };
  if (IN_PROGRESS.test(source)) return { modality: MODALITY.IN_PROGRESS, reason: 'reported as in progress, not finished' };
  if (REQUEST.test(source)) return { modality: MODALITY.REQUEST, reason: 'asked for, not reported as done' };
  if (COMPLETED.test(source)) return { modality: MODALITY.COMPLETED, reason: 'reported as done' };
  return { modality: MODALITY.PLAIN, reason: null };
}

module.exports = {
  MODALITY, classifyModality,
  QUESTION, REQUEST, IN_PROGRESS, COMPLETED, NEGATED,
};
