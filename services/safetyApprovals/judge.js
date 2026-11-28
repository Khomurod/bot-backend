'use strict';

/**
 * A hard Safety decision, decided by Claude from the whole conversation
 * (owner, 28 November 2026; the prompt and the checks are
 * lib/safetyApprovals/judge.js).
 *
 * Asked only where the rules stopped: a team hashtag naming nobody they can
 * read, two answers for one driver, or Safety's words the first reading
 * could not settle ("but we can hire him"). Claude only — the capability is
 * never asked of a free model (lib/ai/escalation.js PAID_ONLY). Not sure, or
 * not reachable: nothing is decided here, and the reviewer asks Safety.
 */

const messages = require('../../database/safetyApprovals/messages');
const reviews = require('../../database/safetyApprovals/reviews');
const { AiUnavailableError, runCapability } = require('../ai/router');
const {
  labelDrivers, buildJudgePrompt, validateJudgement, verifyJudgement,
} = require('../../lib/safetyApprovals/judge');

const CAPABILITY = 'safety_approval_reading';

function log(text) {
  console.log(`[SAFETY APPROVALS] ${text}`);
}

/**
 * @param {object} args
 * @param {string} args.chatId
 * @param {object} args.post          lib/safetyApprovals/bundle.js assemblePost
 * @param {object[]} args.candidates  the post's drivers ({ key, name })
 * @param {object[]} args.triggerRows the message to decide (an album: every item)
 * @param {string} args.triggerText
 * @param {object} args.trigger       lib/safetyApprovals/trigger.js readTrigger
 * @param {string[]} args.safetyIds
 * @param {object} [deps]             { runCapability } — a test seam
 * @returns {Promise<{decisions: object[], candidates: object[], provider, model, dropped}|null>}
 */
async function judgeDecision({
  chatId, post, candidates, triggerRows, triggerText, trigger, safetyIds,
}, deps = {}) {
  const drivers = labelDrivers(candidates);
  if (!drivers.length) return null;
  const run = deps.runCapability || runCapability;
  try {
    const [conversation, decided] = await Promise.all([
      messages.listConversation({ chatId, rootMessageIds: post.messageIds }),
      reviews.listPostDecisions(chatId, post.anchorId),
    ]);
    const { systemText, userText } = buildJudgePrompt({
      drivers,
      decided,
      conversation,
      decisionRows: triggerRows,
      postIds: post.messageIds,
      safetyIds,
      hashtag: trigger.hashtag || null,
    });
    const answer = await run({
      capability: CAPABILITY, systemText, userText, expects: 'json', validate: validateJudgement,
    });
    // Not sure even as Claude: nothing is decided here.
    if (!answer || answer.uncertain) return null;
    const safetyRows = [...conversation, ...triggerRows].filter((r) => safetyIds.includes(String(r.fromUserId)));
    const safetyWords = safetyRows.flatMap((r) => [r.text, ...(r.documents || []).map((d) => d.file_name)]).filter(Boolean);
    const { decisions, dropped } = verifyJudgement(answer.parsed, {
      drivers, hashtag: trigger.hashtag || null, decisionText: triggerText, safetyWords,
    });
    if (!decisions.length) return null;
    return {
      decisions, candidates, dropped, provider: answer.provider ?? null, model: answer.model ?? null,
    };
  } catch (err) {
    // No Claude now: the question is the fallback, as it was before this.
    if (err instanceof AiUnavailableError || err?.aiUnavailable) return null;
    log(`could not judge a decision (${String(err?.message || err).slice(0, 160)})`);
    return null;
  }
}

module.exports = { judgeDecision, CAPABILITY };
