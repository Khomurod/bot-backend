'use strict';

/**
 * Recording that one money code superseded another.
 *
 * WHY IT IS ITS OWN STEP, AFTER THE CODE IS ALREADY STORED. The new code is a
 * real issue regardless of what it replaces: if the link cannot be settled, the
 * money still has to be on the books. So the code is recorded first and the
 * relationship is decided second, and a relationship that cannot be proved
 * costs nothing but a note for a person.
 *
 * NOTHING IS LOST WHEN A CODE IS MARKED REPLACED. The digits, the amount, the
 * original message and the issue time all stay; `replaced_by_id` points at the
 * code that took over and an event records who decided it. What changes is that
 * the old code stops counting as money still in play — which is the whole
 * reason the state exists, because otherwise a re-issue doubles the total.
 *
 * THE EVIDENCE BAR IS HIGHER THAN A VOID'S. See lib/finance/replacement.js: a
 * void may fall back to "the only code in scope", a replacement may not.
 */

const { classifyReplacementLanguage, decideReplacementTarget, REPLACEMENT_DECISION } = require('../../lib/finance/replacement');
const { STATUS } = require('../../lib/finance/moneycode');
const financeMessages = require('../../database/financeMessages');
const lifecycle = require('../../database/financeMoneycodeLifecycle');

/** The same window a void reaches back over, for the same reason. */
const CONTEXT_WINDOW_HOURS = 24;

function defaultDeps() {
  return { lifecycle, messages: financeMessages };
}

/**
 * @param {number} messageRefId  the captured message that issued the new code
 * @param {object} shaped        chatId, replyToMessageId, messageDate, text
 * @param {object} parsed        the reading, already known to be `parsed`
 * @param {number} newCodeId     the money-code row this message just produced
 * @returns `{ applied, decision, replacedId, reason }`
 */
async function applyReplacementFromMessage(messageRefId, shaped, parsed, newCodeId, deps = defaultDeps()) {
  if (!newCodeId || parsed?.status !== STATUS.PARSED || !parsed.codeNormalized) {
    return { applied: false, decision: 'none', replacedId: null, reason: 'no new code' };
  }

  const replacement = classifyReplacementLanguage(shaped.text);
  if (!replacement.isReplacement) {
    return { applied: false, decision: 'none', replacedId: null, reason: replacement.reason };
  }

  const at = shaped.messageDate || new Date();
  const replyToCode = shaped.replyToMessageId
    ? await deps.lifecycle.findCodeByMessage(shaped.chatId, shaped.replyToMessageId)
    : null;
  const recentCodes = await deps.lifecycle.recentCodesInScope({
    chatId: shaped.chatId, before: at, withinHours: CONTEXT_WINDOW_HOURS,
  });

  // Named digits are looked up over all of history, for the same reason the
  // void path does it: the window bounds guessing from context, not reading a
  // number somebody wrote down. A code being replaced is usually OLDER than the
  // window, which is what made this the commoner failure of the two.
  const candidates = [...recentCodes];
  const seen = new Set(candidates.map((c) => c.id));
  for (const digits of replacement.codes || []) {
    if (String(digits) === String(parsed.codeNormalized)) continue;
    // eslint-disable-next-line no-await-in-loop
    for (const row of await deps.lifecycle.findCodesByDigits(digits)) {
      if (!seen.has(row.id)) { seen.add(row.id); candidates.push(row); }
    }
  }

  const target = decideReplacementTarget({
    replacement, newCode: parsed.codeNormalized, replyToCode, recentCodes: candidates,
  });

  if (target.decision === REPLACEMENT_DECISION.LINK) {
    const out = await deps.lifecycle.markReplaced(target.codeId, newCodeId, {
      messageRefId,
      confidence: target.confidence,
      decidedBy: 'deterministic',
      evidence: {
        ...target.evidence,
        replacementCode: parsed.codeNormalized,
        repliedToMessageId: shaped.replyToMessageId ?? null,
      },
    });
    return {
      applied: out.changed, decision: REPLACEMENT_DECISION.LINK, replacedId: target.codeId,
      codeNormalized: target.codeNormalized, confidence: target.confidence,
      reason: out.changed ? null : 'that code was already recorded as replaced',
    };
  }

  if (target.decision === REPLACEMENT_DECISION.NEEDS_REVIEW) {
    await deps.messages.setMessageStatus(messageRefId, STATUS.NEEDS_REVIEW, {
      kind: 'replacement_target_unresolved',
      reason: target.reason,
      evidence: target.evidence,
      newCode: parsed.codeNormalized,
    });
  }
  return {
    applied: false, decision: target.decision, replacedId: null, reason: target.reason,
  };
}

module.exports = { CONTEXT_WINDOW_HOURS, applyReplacementFromMessage, defaultDeps };
