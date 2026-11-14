'use strict';

/**
 * The STAGE READ of one candidate's conversation: what the conversation says
 * about where the candidate is, and what to post about it in the Bitrix topic.
 * Shared by the normal read (reviewer.js) and a read a person asked for with
 * a tag (requested.js) — the same guards for both.
 *
 *   the pipeline's stages → model (redacted words) → verified stage
 *     → a placeholder title ("No name")? offer ✏️ Rename (rename.js)
 *     → deal by name (if none yet) — two people matching: said, nothing proposed
 *     → no deal? the conversation's own, closed, rejected, or CREATE the
 *       contact + deal when the candidate is certain (noDeal.js, crmCreate.js)
 *     → "move X to STAGE?"  or  "no deal — recruiter, please create it" (propose.js)
 *
 * `view` is the conversation as the caller read it: the messages WITHOUT any
 * that mention the bot (a request, never data), the post's words, the phones,
 * the recruiter's post row, whether Safety's #NotApproved stands, and — for a
 * read a person asked for — who asked (`requestedBy`) and why a creation was
 * already refused this read (`noCreate`).
 *
 * `seen` collects what the caller reports: the driver's name (for a Bitrix
 * error line) and whether the candidate has a deal (`hasDeal` — for the
 * reaction that answers a person's request).
 */

const threads = require('../../database/hiringStages/threads');
const conversation = require('../../lib/hiringStages/conversation');
const { verifyStageAnswer } = require('../../lib/hiringStages/proposal');
const { candidateIdentity, certainDisplayName } = require('../../lib/hiringStages/identity');
const msg = require('../../lib/hiringStages/messages');
const { findCandidateDeal } = require('./dealFinder');
const { whenNoDeal, notice } = require('./noDeal');
const { offerRename } = require('./rename');
const { stagesFor, planForDeal } = require('./stagePlan');
const { readConversationStage } = require('./aiReading');
const { propose, done } = require('./propose');

/** After a deal is created, read again this long after — once Bitrix's own automation has moved it. */
const REREAD_AFTER_CREATE_SECONDS = 120;

/** A deal was just created: the next step is proposed on a fresh read, never now. */
async function rereadAfterCreate(thread) {
  await threads.retryThread(thread, { delaySeconds: REREAD_AFTER_CREATE_SECONDS, error: null });
  return 'retry';
}

/** Outcomes that still mean the candidate HAS a deal in Bitrix (closed, but there). */
const DEAL_EXISTS = new Set(['known_deal_closed', 'created_deal_closed']);

/**
 * @param {object} thread  the queue row
 * @param {object} deps    settings, telegram, readStage (a model stand-in in tests)
 * @param {object} seen    filled in for the caller
 * @param {object} view    see the header
 * @param {{status: string, deal?: object}} start  the deal found before the read, if any
 * @returns {Promise<'done'|'retry'>}
 */
async function readStage(thread, deps, seen, view, start) {
  const { settings } = deps;
  const {
    messages, postText, phones, recruiter, newDealCategory, opts,
  } = view;
  let lookup = start;
  if (lookup.deal) seen.hasDeal = true;

  const categoryId = lookup.deal?.categoryId ?? newDealCategory;
  const stages = await stagesFor(categoryId, opts);
  if (!stages.length) return done(thread, { result: 'no_stages', categoryId });

  const currentStage = lookup.deal ? stages.find((s) => s.id === lookup.deal.stageId) || null : null;
  const who = { rootMessageId: thread.rootMessageId, safetyUserIds: settings.safetyUserIds };
  const answer = await (deps.readStage || readConversationStage)({
    transcript: conversation.buildTranscript(messages, who),
    stages,
    currentStage,
    subjectKey: `${thread.chatId}:${thread.rootMessageId}`,
  });
  const verified = verifyStageAnswer(answer.parsed, {
    stages, currentStageId: lookup.deal?.stageId ?? null, searchable: conversation.searchableText(messages),
  });

  // The spelling written to Bitrix comes from Safety's own words, by rules — never the model's.
  const safetyTexts = conversation.safetyTexts(messages, who);
  const offered = new Set();
  // A placeholder title ("No name") on the deal this card is about is offered
  // a name whatever the stage read says — and only once per deal per read.
  // Only with ONE phone in the conversation: with two, the deal found may be
  // another person's number, and a "No name" deal must not take this name.
  const offerFor = async (deal, driverName) => {
    if (!deal || offered.has(deal.id) || phones.length !== 1) return;
    offered.add(deal.id);
    await offerRename(thread, deps, { deal, displayName: certainDisplayName({ postText, safetyTexts }), driverName });
  };
  await offerFor(lookup.deal, seen.driverName);
  if (!verified.move) return done(thread, { result: verified.reason, model: answer.model });

  const identity = candidateIdentity({
    postText, phones, modelName: verified.driverName, safetyTexts,
  });
  // ONE NAME: the post's, when it has one certain name; the model's only otherwise.
  const name = identity.name || verified.driverName || null;
  if (name) seen.driverName = name;
  if (!lookup.deal && name) lookup = await findCandidateDeal({ name }, opts);
  if (lookup.status === 'ambiguous') {
    await notice(thread, deps, 'ambiguous', msg.ambiguousLine({ count: lookup.count }), name);
    return done(thread, { result: 'ambiguous', people: lookup.count });
  }

  const ctx = {
    recruiter, phones, stage: verified.stage, driverName: name, evidence: verified.evidence, deal: null, note: null,
  };
  let deal = lookup.deal || null;
  if (!deal) {
    if (!name && !phones.length) return done(thread, { result: 'no_identity' });
    const rejected = verified.stage.semantics === 'F' || view.rejectedBySafety;
    const missing = await whenNoDeal(thread, ctx, {
      identity, categoryId, stages, rejected, requestedBy: view.requestedBy || null, noCreate: view.noCreate || null,
    }, deps, opts);
    if (missing.outcome) {
      if (DEAL_EXISTS.has(missing.outcome.result)) seen.hasDeal = true;
      return done(thread, missing.outcome);
    }
    if (missing.created) {
      // A new deal starts at "Sent to Safety", and Bitrix's own automation may
      // carry it into the Safety pipeline at once: the next step is proposed
      // on a fresh read, in whatever pipeline the deal is then — never now.
      seen.hasDeal = true;
      return rereadAfterCreate(thread);
    }
    deal = missing.deal || null;
  }
  if (deal) {
    seen.hasDeal = true;
    await offerFor(deal, name);
    const plan = await planForDeal(deal, verified.stage, { stages, categoryId }, opts);
    if (!plan.ok) return done(thread, { result: plan.reason, dealId: deal.id });
    Object.assign(ctx, { deal, plan });
  }
  return propose(thread, ctx, deps);
}

module.exports = {
  readStage, rereadAfterCreate, DEAL_EXISTS, REREAD_AFTER_CREATE_SECONDS,
};
