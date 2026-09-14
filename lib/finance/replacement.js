'use strict';

/**
 * "This code replaces that one." PURE — text and candidates in, a decision out.
 *
 * WHY THIS IS NOT INFERRED FROM TIMING. The tempting rule is: a code was
 * voided, a new one appeared minutes later, so the new one replaces it. That
 * rule is wrong often enough to be dangerous. A finance group issues codes to
 * several drivers in the same minutes; the next code is usually somebody else's
 * money. Chaining the two would invent a relationship nobody stated, and then
 * report it as history.
 *
 * SO A REPLACEMENT IS RECORDED ONLY WHEN A MESSAGE SAID SO, and only when the
 * message also carries hard evidence of WHICH code it means:
 *
 *   1. it names the old code's digits, and we hold that code; or
 *   2. it replies to the message that issued the old code.
 *
 * There is deliberately NO "only candidate in scope" rung here, which the void
 * ladder does have. A void says something about money that has already been
 * spent and is usually the only thing in flight; a replacement asserts a link
 * between two payments, and getting that link wrong silently merges two
 * drivers' money into one story.
 *
 * AND THE TWO PIECES OF EVIDENCE DISAGREEING IS ALWAYS `needs_review`, for the
 * same reason as in `void/target.js`: two hard facts pointing at different
 * money is exactly when a machine should stop.
 */

const { classifyModality, MODALITY } = require('./phrasing');
const { scanCodes } = require('./moneycode/values');

const REPLACEMENT_DECISION = Object.freeze({
  LINK: 'link',
  NEEDS_REVIEW: 'needs_review',
  NONE: 'none',
});

const REPLACEMENT_CONFIDENCE = Object.freeze({
  NAMED_AND_REPLIED: 99,
  NAMED: 95,
  REPLIED: 90,
});

/**
 * The subject words. "New code" alone is NOT one of them — a group posts new
 * codes all day and almost none of them replace anything.
 */
const REPLACEMENT_WORDS = /\b(replac(?:e|es|ed|ing|ement)|re-?issu(?:e|ed|ing)|reissu(?:e|ed|ing)|supersed(?:e|es|ed)|instead of)\b/i;

/**
 * Is this message stating a replacement?
 *
 * @returns `{ isReplacement, codes, phrase, reason }`. `codes` are the
 *   code-shaped digit runs the message itself named, verbatim — including the
 *   new code, which the caller separates out because only the caller knows
 *   which code the message issued.
 */
function classifyReplacementLanguage(text) {
  const source = String(text || '');
  const none = { isReplacement: false, codes: [], phrase: null, reason: null };
  if (!REPLACEMENT_WORDS.test(source)) return none;

  const codes = scanCodes(source);
  const phrase = (source.match(REPLACEMENT_WORDS) || [])[0] || null;
  const { modality, reason } = classifyModality(source);

  // Anything that is not a statement of fact is context, not a relationship.
  if (modality === MODALITY.NEGATED || modality === MODALITY.QUESTION
      || modality === MODALITY.IN_PROGRESS || modality === MODALITY.REQUEST) {
    return { isReplacement: false, codes, phrase, reason: reason || 'not stated as done' };
  }

  // PLAIN counts here and does NOT count for a void, and the asymmetry is
  // deliberate: "void this" is an instruction, but "replacement code: 123" —
  // posted beside an actual new code — is a report of what was just issued.
  return { isReplacement: true, codes, phrase, reason: 'stated as a replacement' };
}

function byDigits(codes, digits) {
  return (codes || []).find((c) => c && String(c.codeNormalized) === String(digits)) || null;
}

/**
 * Which code did this one replace?
 *
 * @param {object} input
 * @param {object} input.replacement  from `classifyReplacementLanguage`
 * @param {string} input.newCode      the code THIS message issued, normalised
 * @param {object|null} input.replyToCode  the code issued by the message this
 *   one replies to, when there is one
 * @param {Array} input.recentCodes   `{ id, codeNormalized, status }` in scope
 * @returns `{ decision, codeId, codeNormalized, confidence, evidence, reason }`
 */
function decideReplacementTarget({
  replacement, newCode = null, replyToCode = null, recentCodes = [],
} = {}) {
  const none = {
    decision: REPLACEMENT_DECISION.NONE, codeId: null, codeNormalized: null,
    confidence: 0, evidence: null, reason: null,
  };
  if (!replacement || !replacement.isReplacement) return none;
  if (!newCode) {
    return { ...none, reason: 'the message states a replacement but issues no code' };
  }

  // The new code's own digits are in the text; they are not a candidate for
  // the thing being replaced.
  const namedOther = [...new Set((replacement.codes || [])
    .map(String)
    .filter((d) => d !== String(newCode)))];
  const namedKnown = namedOther.map((d) => byDigits(recentCodes, d)).filter(Boolean);

  if (namedOther.length && !namedKnown.length) {
    return {
      ...none,
      decision: REPLACEMENT_DECISION.NEEDS_REVIEW,
      evidence: { kind: 'named_unknown_code', codes: namedOther },
      reason: 'the message names a replaced code with no matching record',
    };
  }
  if (namedKnown.length > 1) {
    return {
      ...none,
      decision: REPLACEMENT_DECISION.NEEDS_REVIEW,
      evidence: { kind: 'named_several', codes: namedKnown.map((c) => c.codeNormalized) },
      reason: 'the message names more than one code it could be replacing',
    };
  }

  const namedRow = namedKnown[0] || null;
  const repliedRow = replyToCode && String(replyToCode.codeNormalized) !== String(newCode)
    ? replyToCode
    : null;

  if (namedRow && repliedRow
      && String(namedRow.codeNormalized) !== String(repliedRow.codeNormalized)) {
    return {
      ...none,
      decision: REPLACEMENT_DECISION.NEEDS_REVIEW,
      evidence: {
        kind: 'conflicting_evidence',
        named: namedRow.codeNormalized,
        repliedTo: repliedRow.codeNormalized,
      },
      reason: 'the message names one code and replies to another',
    };
  }

  const chosen = namedRow || repliedRow;
  if (!chosen) {
    return {
      ...none,
      decision: REPLACEMENT_DECISION.NEEDS_REVIEW,
      evidence: { kind: 'no_named_target' },
      reason: 'nothing in the message says which code this replaces',
    };
  }

  return {
    decision: REPLACEMENT_DECISION.LINK,
    codeId: chosen.id ?? null,
    codeNormalized: chosen.codeNormalized,
    confidence: namedRow && repliedRow
      ? REPLACEMENT_CONFIDENCE.NAMED_AND_REPLIED
      : (namedRow ? REPLACEMENT_CONFIDENCE.NAMED : REPLACEMENT_CONFIDENCE.REPLIED),
    evidence: {
      kind: namedRow && repliedRow ? 'named_and_replied' : (namedRow ? 'named' : 'replied_to'),
      phrase: replacement.phrase,
    },
    reason: null,
  };
}

module.exports = {
  REPLACEMENT_DECISION, REPLACEMENT_CONFIDENCE, REPLACEMENT_WORDS,
  classifyReplacementLanguage, decideReplacementTarget,
};
