'use strict';

/**
 * Reading one candidate's conversation and, when it has moved on, proposing
 * the Bitrix stage — the work behind one queue row.
 *
 *   conversation (General) → candidate post? → deal by phone → pipeline stages
 *     → model (redacted words) → verified stage → deal by name (if none yet)
 *     → no deal? the conversation's own deal, closed, rejected, or CREATE
 *       contact + deal when the candidate is certain (noDeal.js, crmCreate.js)
 *     → a deal with a placeholder title ("No name")? offer ✏️ Rename
 *       (rename.js) — a deal found by phone is offered right after the read,
 *       whatever the read says, and whether or not a creation would be certain
 *     → "move X to STAGE?"  or  "no deal — recruiter, please create it"
 *       (both in the Bitrix topic: propose.js)
 *
 * ONLY A CANDIDATE POST IS READ. The General topic also carries "the driver is
 * there" and "office is closed"; a candidate post carries a picture (the CDL)
 * or the driver's phone number. A post with neither is not a candidate, and
 * costs no model call.
 *
 * A MISSING DEAL IS CREATED ONLY FOR A CERTAIN CANDIDATE: one name read off
 * the post, one phone a recruiter typed (lib/hiringStages/identity.js), and
 * nobody else in Bitrix holding either — and NEVER when the conversation
 * already has a deal (open or closed) or the candidate was rejected
 * (noDeal.js). Anything less certain — or a recruiter who already pressed
 * Skip — asks a person instead, with the reason. Two people matching the
 * name is said in the Bitrix topic, and nothing is proposed.
 *
 * Returns the queue status it left the row in; never throws for a failure it
 * can name (AI or Bitrix down → retry; after six attempts → gave_up). A Bitrix
 * failure that ends the read is said in the Bitrix topic, once.
 */

const threads = require('../../database/hiringStages/threads');
const conversation = require('../../lib/hiringStages/conversation');
const { verifyStageAnswer } = require('../../lib/hiringStages/proposal');
const { candidateIdentity, certainDisplayName } = require('../../lib/hiringStages/identity');
const { extractPhones } = require('../../lib/hiringStages/redact');
const { isImageDocument } = require('../../lib/safetyApprovals/messageShape');
const { namesInPost } = require('../../lib/safetyApprovals/postDetails');
const msg = require('../../lib/hiringStages/messages');
const { stripUrls } = require('../../lib/security/redactUrls');
const { getBitrixConfig } = require('../../database/bitrix');
const { BitrixError } = require('../bitrix24DealStages');
const { findCandidateDeal } = require('./dealFinder');
const { resumeInFlight } = require('./crmCreate');
const {
  whenNoDeal, sayCreated, notice, RetryLater,
} = require('./noDeal');
const { offerRename } = require('./rename');
const { stagesFor, planForDeal } = require('./stagePlan');
const { readConversationStage, AiUnavailableError } = require('./aiReading');
const { propose, done } = require('./propose');

const RETRY_DELAYS_SECONDS = [60, 300, 900, 1800, 3600];
/** 1 + 5 + 15 + 30 + 60 minutes of trying; a new message in the conversation starts over. */
const MAX_ATTEMPTS = 6;

/** A candidate post carries a picture (the CDL) or a phone number to reach the driver on. */
function isCandidatePost(post) {
  return post.some((m) => m.photos?.length || (m.documents || []).some(isImageDocument)
    || extractPhones(m.text || '').length > 0);
}

/** After a deal is created, read again this long after — once Bitrix's own automation has moved it. */
const REREAD_AFTER_CREATE_SECONDS = 120;

async function readAndPropose(thread, deps, seen) {
  const { settings } = deps;
  const messages = await threads.listThreadMessages(thread.chatId, thread.rootMessageId);
  const post = conversation.postMessages(messages, thread.rootMessageId);
  if (!post.length) return done(thread, { result: 'no_post' });
  if (!conversation.hasReplies(messages, thread.rootMessageId)) return done(thread, { result: 'no_conversation' });
  if (!isCandidatePost(post)) return done(thread, { result: 'not_a_candidate_post' });

  const postText = conversation.postText(messages, thread.rootMessageId);
  const postNames = namesInPost(postText);
  seen.driverName = postNames.length === 1 ? postNames[0] : null;
  const recruiter = post[0];
  const opts = { fetchImpl: deps.fetchImpl };
  const phones = conversation.candidatePhones(messages, { rootMessageId: thread.rootMessageId, safetyUserIds: settings.safetyUserIds });
  const newDealCategory = (await getBitrixConfig()).dealCategoryId || '0';

  // A creation an earlier read left without an answer is finished first.
  const resumed = await resumeInFlight({
    chatId: thread.chatId,
    rootMessageId: thread.rootMessageId,
    categoryId: newDealCategory,
    loadStages: () => stagesFor(newDealCategory, opts),
  }, opts);
  if (resumed) await sayCreated(thread, deps, resumed, resumed.stages);
  if (resumed?.status === 'created') {
    await threads.retryThread(thread, { delaySeconds: REREAD_AFTER_CREATE_SECONDS, error: null });
    return 'retry';
  }
  let lookup;
  if (resumed?.deal) lookup = { status: 'found', deal: resumed.deal };
  else lookup = phones.length ? await findCandidateDeal({ phones }, opts) : { status: 'none' };

  const categoryId = lookup.deal?.categoryId ?? newDealCategory;
  const stages = await stagesFor(categoryId, opts);
  if (!stages.length) return done(thread, { result: 'no_stages', categoryId });

  const currentStage = lookup.deal ? stages.find((s) => s.id === lookup.deal.stageId) || null : null;
  const answer = await (deps.readStage || readConversationStage)({
    transcript: conversation.buildTranscript(messages, { rootMessageId: thread.rootMessageId, safetyUserIds: settings.safetyUserIds }),
    stages,
    currentStage,
    subjectKey: `${thread.chatId}:${thread.rootMessageId}`,
  });
  const verified = verifyStageAnswer(answer.parsed, {
    stages, currentStageId: lookup.deal?.stageId ?? null, searchable: conversation.searchableText(messages),
  });

  const who = { rootMessageId: thread.rootMessageId, safetyUserIds: settings.safetyUserIds };
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
    const rejected = verified.stage.semantics === 'F' || conversation.safetyRejected(messages, who);
    const missing = await whenNoDeal(thread, ctx, {
      identity, categoryId, stages, rejected,
    }, deps, opts);
    if (missing.outcome) return done(thread, missing.outcome);
    if (missing.created) {
      // A new deal starts at "Sent to Safety", and Bitrix's own automation may
      // carry it into the Safety pipeline at once: the next step is proposed
      // on a fresh read, in whatever pipeline the deal is then — never now.
      await threads.retryThread(thread, { delaySeconds: REREAD_AFTER_CREATE_SECONDS, error: null });
      return 'retry';
    }
    deal = missing.deal || null;
  }
  if (deal) {
    await offerFor(deal, name);
    const plan = await planForDeal(deal, verified.stage, { stages, categoryId }, opts);
    if (!plan.ok) return done(thread, { result: plan.reason, dealId: deal.id });
    Object.assign(ctx, { deal, plan });
  }
  return propose(thread, ctx, deps);
}

function retryable(err) {
  if (err instanceof AiUnavailableError || err instanceof RetryLater) return true;
  if (err instanceof BitrixError) return err.retryable;
  return true;
}

/** A Bitrix failure that ends this read is said in the Bitrix topic — once per revision. */
async function sayBitrixFailed(thread, deps, err, seen) {
  if (!(err instanceof BitrixError)) return;
  await notice(thread, deps, `bitrix_error:${thread.revision}`, msg.bitrixErrorLine({ error: stripUrls(err.message) }), seen.driverName);
}

/** @returns {Promise<'done'|'retry'|'gave_up'>} */
async function processThread(thread, deps) {
  const seen = { driverName: null };
  try {
    return await readAndPropose(thread, deps, seen);
  } catch (err) {
    const error = String(err?.message || err).slice(0, 300);
    if (!retryable(err)) {
      await threads.finishThread(thread, { status: 'done', outcome: { result: 'bitrix_error' }, error });
      await sayBitrixFailed(thread, deps, err, seen);
      return 'done';
    }
    if (thread.attempts >= MAX_ATTEMPTS) {
      await threads.finishThread(thread, { status: 'gave_up', error });
      await sayBitrixFailed(thread, deps, err, seen);
      return 'gave_up';
    }
    const delay = RETRY_DELAYS_SECONDS[Math.min(thread.attempts - 1, RETRY_DELAYS_SECONDS.length - 1)];
    await threads.retryThread(thread, { delaySeconds: delay, error });
    return 'retry';
  }
}

module.exports = { processThread, isCandidatePost, MAX_ATTEMPTS, RETRY_DELAYS_SECONDS };
