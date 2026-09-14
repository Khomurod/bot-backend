'use strict';

/**
 * Which money code does this void refer to? PURE — candidates in, a decision
 * out. No database, no clock of its own.
 *
 * THE RULE THAT OUTRANKS CONVENIENCE: when more than one code is plausible,
 * this returns `needs_review`. It does not pick the nearest, the newest or the
 * largest. Marking the wrong code dead is not a smaller mistake than marking
 * none — it is a worse one, because it looks like an answer.
 *
 * EVIDENCE IS RETURNED WITH EVERY DECISION and stored with the void, so that
 * "why is this code voided" is answerable months later without re-reading the
 * chat. A link whose reason cannot be written down is a link this refuses to
 * make.
 *
 * THE LADDER, strongest first:
 *
 *   1. The message NAMES a code, and it is one we hold.
 *   2. The message is a REPLY to the message that issued a code.
 *   3. Exactly one active code is in scope, and nothing contradicts it.
 *
 * Rungs 1 and 2 agreeing is the strongest evidence available. Rungs 1 and 2
 * DISAGREEING is the most dangerous case in the file and is always
 * `needs_review`: two pieces of hard evidence pointing at different money is
 * precisely when a machine should stop.
 */

const DECISION = Object.freeze({
  LINK: 'link',
  NEEDS_REVIEW: 'needs_review',
  ALREADY_VOIDED: 'already_voided',
  NONE: 'none',
});

/** Contextual association is allowed only at or above this confidence. */
const MIN_CONTEXT_CONFIDENCE = 75;

const CONFIDENCE = Object.freeze({
  NAMED_AND_REPLIED: 99,
  NAMED: 95,
  REPLIED: 95,
  ONLY_CANDIDATE: 80,
});

/**
 * The rows that still represent money in play.
 *
 * ONE DEFINITION, used by both the named lookup and the context rung. They used
 * to differ — one merely excluded voided and replaced, which left a repeat
 * POSTING eligible to be voided as though it were the debt. A repeat is a row
 * recorded so the repeat is visible; it was never a second payment.
 */
function liveOnly(codes) {
  return (codes || []).filter((c) => c && (c.status === 'active' || c.status === 'needs_review'));
}

/**
 * Every row recorded under those digits — not the first one found.
 *
 * The same code CAN appear twice: a repeat posting is recorded rather than
 * discarded. Returning one of them as though it were the only one would void
 * whichever happened to sort first, which is a coin toss against money.
 */
function rowsWithDigits(codes, digits) {
  return (codes || []).filter((c) => String(c.codeNormalized) === String(digits));
}

/**
 * The row a named code resolves to: the single live one when there is exactly
 * one, and otherwise nothing to act on — either because several are live (the
 * caller refuses) or because none is, in which case the newest spent row is
 * returned so the answer can be "that is already voided" rather than "unknown".
 */
function resolveNamed(codes, digits) {
  const rows = rowsWithDigits(codes, digits);
  const live = liveOnly(rows);
  if (live.length > 1) return { digits, rows, row: null, ambiguous: true };
  return { digits, rows, row: live.length === 1 ? live[0] : (rows[0] || null), ambiguous: false };
}

/**
 * @param {object} input
 * @param {{kind: string, codes: string[]}} input.voiding  from `intent.js`
 * @param {object|null} input.replyToCode   the code issued by the message this
 *   one replies to, when there is one
 * @param {Array}  input.recentCodes        codes in scope, each
 *   `{ id, codeNormalized, status }`
 * @param {object} [options] `{ minConfidence }`
 * @returns `{ decision, codeId, codeNormalized, confidence, evidence, reason }`
 */
function decideVoidTarget({ voiding, replyToCode = null, recentCodes = [] } = {}, options = {}) {
  const minConfidence = Number.isFinite(Number(options.minConfidence))
    ? Number(options.minConfidence)
    : MIN_CONTEXT_CONFIDENCE;

  const none = {
    decision: DECISION.NONE, codeId: null, codeNormalized: null,
    confidence: 0, evidence: null, reason: null,
  };
  if (!voiding || voiding.kind === 'none') return none;

  // A REQUEST IS NOT A VOID, and this function says so itself rather than
  // trusting its caller to have checked. `voidService` does check — but a pure
  // decision that only holds because of who calls it is one refactor away from
  // not holding at all, and the thing on the other side of that refactor is
  // "please void this" silently killing a live code.
  if (voiding.kind !== 'completed') {
    return { ...none, reason: 'a request to void is not a completed void' };
  }

  // A NAMED CODE IS RESOLVED FROM EVERY ROW THE CALLER FOUND, and the caller is
  // expected to have looked it up by digits rather than only inside a time
  // window — see `voidService`. Digits somebody wrote out are not a guess from
  // context and must not expire.
  // Several LIVE rows under one code is the one case a machine cannot settle.
  // One live row beside a spent one — a repeat posting, or an earlier void — is
  // not ambiguous at all: only one of them is money in play.
  const named = (voiding.codes || []).map((digits) => resolveNamed(recentCodes, digits));
  const namedAmbiguous = named.find((n) => n.ambiguous);
  if (namedAmbiguous) {
    return {
      ...none,
      decision: DECISION.NEEDS_REVIEW,
      evidence: { kind: 'code_recorded_more_than_once', code: namedAmbiguous.digits, rows: namedAmbiguous.rows.length },
      reason: 'that code is recorded more than once and more than one is still live',
    };
  }
  const namedKnown = named.filter((n) => n.row);

  // Named a code we have no record of. Not ambiguous — unknown, which is
  // exactly the kind of thing a person should be shown rather than a machine
  // resolving it to the nearest thing it does hold.
  if (named.length && !namedKnown.length) {
    return {
      ...none,
      decision: DECISION.NEEDS_REVIEW,
      evidence: { kind: 'named_unknown_code', codes: named.map((n) => n.digits) },
      reason: 'the message names a code with no matching record',
    };
  }

  if (namedKnown.length > 1) {
    return {
      ...none,
      decision: DECISION.NEEDS_REVIEW,
      evidence: { kind: 'named_several', codes: namedKnown.map((n) => n.digits) },
      reason: 'the message names more than one code we hold',
    };
  }

  const namedRow = namedKnown.length ? namedKnown[0].row : null;

  // The dangerous case, checked before either piece of evidence is used alone.
  if (namedRow && replyToCode && String(namedRow.codeNormalized) !== String(replyToCode.codeNormalized)) {
    return {
      ...none,
      decision: DECISION.NEEDS_REVIEW,
      evidence: {
        kind: 'conflicting_evidence',
        named: namedRow.codeNormalized,
        repliedTo: replyToCode.codeNormalized,
      },
      reason: 'the message names one code and replies to another',
    };
  }

  const chosen = namedRow || replyToCode || null;
  if (chosen) {
    const confidence = namedRow && replyToCode
      ? CONFIDENCE.NAMED_AND_REPLIED
      : (namedRow ? CONFIDENCE.NAMED : CONFIDENCE.REPLIED);
    if (chosen.status === 'voided') {
      return {
        decision: DECISION.ALREADY_VOIDED,
        codeId: chosen.id ?? null,
        codeNormalized: chosen.codeNormalized,
        confidence,
        evidence: { kind: namedRow && replyToCode ? 'named_and_replied' : (namedRow ? 'named' : 'replied_to') },
        reason: 'that code is already voided',
      };
    }
    return {
      decision: DECISION.LINK,
      codeId: chosen.id ?? null,
      codeNormalized: chosen.codeNormalized,
      confidence,
      evidence: { kind: namedRow && replyToCode ? 'named_and_replied' : (namedRow ? 'named' : 'replied_to') },
      reason: null,
    };
  }

  // Nothing hard. Context is allowed only when there is exactly one thing it
  // could mean.
  const candidates = liveOnly(recentCodes);
  if (candidates.length === 1 && CONFIDENCE.ONLY_CANDIDATE >= minConfidence) {
    return {
      decision: DECISION.LINK,
      codeId: candidates[0].id ?? null,
      codeNormalized: candidates[0].codeNormalized,
      confidence: CONFIDENCE.ONLY_CANDIDATE,
      evidence: { kind: 'only_active_code_in_scope', considered: candidates.length },
      reason: null,
    };
  }

  return {
    ...none,
    decision: DECISION.NEEDS_REVIEW,
    evidence: { kind: 'no_single_candidate', considered: candidates.length },
    reason: candidates.length
      ? `${candidates.length} codes could be meant and nothing says which`
      : 'no code in scope for this void',
  };
}

module.exports = { DECISION, CONFIDENCE, MIN_CONTEXT_CONFIDENCE, decideVoidTarget };
