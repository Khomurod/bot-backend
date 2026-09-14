'use strict';

/**
 * Turning "voided" in a chat into a state on a money code.
 *
 * THE DANGEROUS DIRECTION IS ONE-WAY. Marking a live code dead makes real money
 * disappear from a total; failing to mark a dead one leaves a number slightly
 * too high and a person able to see why. So every uncertainty here resolves
 * towards "a person looks at it", and never towards a guess.
 *
 * THREE THINGS HAVE TO BE TRUE before a code is voided automatically:
 *
 *   1. the message REPORTS a completed void, not a request or a question
 *      (lib/finance/void/intent.js);
 *   2. the target is identifiable from hard evidence — the message names the
 *      code, or replies to the message that issued it — or there is exactly one
 *      code it could possibly mean (lib/finance/void/target.js);
 *   3. the evidence can be written down, because it is.
 *
 * Anything else marks the MESSAGE as needing review, which is how it reaches
 * the screen that lists what a person still has to settle. Nothing is deleted
 * and no total is silently adjusted.
 */

const { VOID_KIND } = require('../../lib/finance/void/intent');
const { decideVoidTarget, DECISION } = require('../../lib/finance/void/target');
const { STATUS } = require('../../lib/finance/moneycode');
const financeMessages = require('../../database/financeMessages');
const lifecycle = require('../../database/financeMoneycodeLifecycle');

/** How far back a void may reach for context when it names nothing. */
const CONTEXT_WINDOW_HOURS = 24;

function defaultDeps() {
  return { lifecycle, messages: financeMessages };
}

/**
 * Resolve and apply one void message.
 *
 * @param {object} shaped     the captured message (chatId, messageId, replyToMessageId, messageDate)
 * @param {object} parsed     the parser's reading, already known to be a void
 * @returns `{ applied, decision, codeId, reason }` — never throws, because this
 *   runs inside the capture path and a message must be stored whether or not
 *   its meaning could be settled.
 */
async function applyVoidFromMessage(messageRefId, shaped, parsed, deps = defaultDeps()) {
  const voiding = parsed?.void;
  if (!voiding || voiding.kind === VOID_KIND.NONE) {
    return { applied: false, decision: 'none', codeId: null, reason: 'not a void' };
  }

  // A REQUEST IS NOT AN ACTION. It is kept as context — the message is stored
  // with its own status — and it changes no money.
  if (voiding.kind !== VOID_KIND.COMPLETED) {
    return { applied: false, decision: 'request', codeId: null, reason: voiding.reason };
  }

  const at = shaped.messageDate || new Date();
  const replyToCode = shaped.replyToMessageId
    ? await deps.lifecycle.findCodeByMessage(shaped.chatId, shaped.replyToMessageId)
    : null;
  const recentCodes = await deps.lifecycle.recentCodesInScope({
    chatId: shaped.chatId, before: at, withinHours: CONTEXT_WINDOW_HOURS,
  });

  const target = decideVoidTarget({ voiding, replyToCode, recentCodes });

  if (target.decision === DECISION.LINK) {
    const out = await deps.lifecycle.voidCode(target.codeId, {
      messageRefId,
      confidence: target.confidence,
      decidedBy: 'deterministic',
      at,
      evidence: {
        ...target.evidence,
        phrase: voiding.phrase,
        namedCodes: voiding.codes,
        repliedToMessageId: shaped.replyToMessageId ?? null,
      },
    });
    return {
      applied: out.changed, decision: DECISION.LINK, codeId: target.codeId,
      codeNormalized: target.codeNormalized, confidence: target.confidence,
      reason: out.changed ? null : 'that code was already voided',
    };
  }

  if (target.decision === DECISION.ALREADY_VOIDED) {
    return {
      applied: false, decision: DECISION.ALREADY_VOIDED, codeId: target.codeId,
      reason: target.reason,
    };
  }

  // Could not settle it. The message becomes the thing a person looks at, with
  // what was considered written beside it — so the screen can say WHY rather
  // than only that something is unclear.
  await deps.messages.setMessageStatus(messageRefId, STATUS.NEEDS_REVIEW, {
    kind: 'void_target_unresolved',
    reason: target.reason,
    evidence: target.evidence,
    namedCodes: voiding.codes,
  });
  return {
    applied: false, decision: DECISION.NEEDS_REVIEW, codeId: null, reason: target.reason,
  };
}

module.exports = { CONTEXT_WINDOW_HOURS, applyVoidFromMessage, defaultDeps };
