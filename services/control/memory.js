'use strict';

/**
 * Writing down what the owner just said, so they are not asked it again.
 *
 * WHEN A MEMORY IS WRITTEN — and this is the whole policy, in two lines:
 *
 *   every `dismiss`            "no" is an answer about a situation, and the
 *                              situation will be re-derived by the next sweep.
 *                              Not remembering it is what made the owner answer
 *                              the same question every week.
 *   `approve` with "always"    recorded, never re-applied. See below.
 *
 * A `snooze` is NOT remembered: "later" is a delay, and the finding's own
 * snooze window already holds it.
 *
 * WHAT A REMEMBERED APPROVAL DOES. Nothing, by itself. It is stored because
 * "you have said yes to this three times" is the input B3's learning pass reads
 * when it suggests putting a check on autopilot — a suggestion a person accepts
 * on a screen, where the permission is visible and revocable. Re-applying it
 * from a chat reply would be the same permission granted invisibly.
 *
 * FAILURE IS SILENT, ON PURPOSE. The owner's answer has already been carried
 * out by the time this runs. A memory that could not be written means the
 * question comes back later, which is a nuisance; an exception here would mean
 * the acknowledgement never reaches them, which looks like the answer was
 * ignored.
 */
const defaultKnowledge = require('../../database/controlKnowledge');
const { fingerprintFor, isRememberable } = require('../../lib/control/fingerprint');

/** Which outcomes are worth remembering, given what the reply chose. */
function shouldRemember({ outcome, intent }) {
  if (outcome === 'dismissed') return true;
  if (outcome === 'applied' && intent?.remember === true) return true;
  return false;
}

/**
 * Record the answer against the CONDITION it answered.
 *
 * @returns {Promise<object|null>} the memory row, or null when this check has
 *   no fingerprint definition — which means it is asked every time, and is not
 *   an error.
 */
async function rememberAnswerFor({
  finding, intent, telegramUserId, replyId = null,
}, deps = { knowledge: defaultKnowledge }) {
  if (!finding || !isRememberable(finding.checkKey)) return null;
  const evidenceFingerprint = fingerprintFor(finding);
  if (!evidenceFingerprint) return null;

  return deps.knowledge.rememberAnswer({
    checkKey: finding.checkKey,
    subjectType: finding.subjectType,
    subjectId: String(finding.subjectId),
    answerAction: intent.action,
    // THE OWNER'S OWN WORDS. What comes back at them weeks later, in the
    // admin's list and in the dismissal reason, has to be the sentence they
    // wrote — a rephrasing is a different claim wearing their authority.
    answerText: intent.reason || null,
    evidenceFingerprint,
    confirmedBy: `telegram:${telegramUserId}`,
    replyId,
  });
}

module.exports = { shouldRemember, rememberAnswerFor };
