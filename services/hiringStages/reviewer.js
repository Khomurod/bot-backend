'use strict';

/**
 * Reading one candidate's conversation and, when it has moved on, proposing
 * the Bitrix stage — the work behind one queue row.
 *
 *   conversation (General) → candidate post? → deal by phone → pipeline stages
 *     → model (redacted words) → verified stage → deal by name (if none yet)
 *     → no deal and the candidate certain? CREATE contact + deal (crmCreate.js)
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
 * nobody else in Bitrix holding either. Anything less — or a recruiter who
 * already pressed Skip — asks a person instead, with the reason. Two people
 * matching the name is said in the Bitrix topic, and nothing is proposed.
 *
 * Returns the queue status it left the row in; never throws for a failure it
 * can name (AI or Bitrix down → retry; after six attempts → gave_up). A Bitrix
 * failure that ends the read is said in the Bitrix topic, once.
 */

const threads = require('../../database/hiringStages/threads');
const proposals = require('../../database/hiringStages/proposals');
const conversation = require('../../lib/hiringStages/conversation');
const { verifyStageAnswer } = require('../../lib/hiringStages/proposal');
const { candidateIdentity } = require('../../lib/hiringStages/identity');
const { extractPhones } = require('../../lib/hiringStages/redact');
const { isImageDocument } = require('../../lib/safetyApprovals/messageShape');
const { namesInPost } = require('../../lib/safetyApprovals/postDetails');
const msg = require('../../lib/hiringStages/messages');
const { stripUrls } = require('../../lib/security/redactUrls');
const { getBitrixConfig } = require('../../database/bitrix');
const { BitrixError, dealUrl } = require('../bitrix24DealStages');
const { findCandidateDeal } = require('./dealFinder');
const { ensureCandidateDeal, resumeInFlight } = require('./crmCreate');
const { stagesFor, planForDeal } = require('./stagePlan');
const { readConversationStage, AiUnavailableError } = require('./aiReading');
const { propose, done } = require('./propose');
const group = require('./groupMessages');

const RETRY_DELAYS_SECONDS = [60, 300, 900, 1800, 3600];
/** 1 + 5 + 15 + 30 + 60 minutes of trying; a new message in the conversation starts over. */
const MAX_ATTEMPTS = 6;

/** A candidate post carries a picture (the CDL) or a phone number to reach the driver on. */
function isCandidatePost(post) {
  return post.some((m) => m.photos?.length || (m.documents || []).some(isImageDocument)
    || extractPhones(m.text || '').length > 0);
}

const notice = (thread, deps, key, text) => group.sendNotice(deps.telegram, deps.settings?.bitrixTopicId, {
  chatId: thread.chatId, rootMessageId: thread.rootMessageId, key, text,
});

/** Not a failure — somebody else's step must finish first. Retried on the same schedule. */
class RetryLater extends Error {}

/** "Created a deal for X" — once per conversation, whichever read finished the creation. */
async function sayCreated(thread, deps, made, stages) {
  if (made?.status !== 'created') return;
  await notice(thread, deps, 'created', msg.createdText({
    chatId: thread.chatId,
    rootMessageId: thread.rootMessageId,
    driverName: made.driverName,
    driverPhone: made.phone,
    dealId: made.deal.id,
    dealTitle: made.deal.title,
    dealUrl: await dealUrl(made.deal.id),
    stageName: stages.find((s) => s.id === made.deal.stageId)?.name || made.deal.stageId,
    contactReused: made.contactReused,
  }));
}

/**
 * No open deal was found. Create one when the candidate is certain, and say
 * so; otherwise leave the reason for the "please create it" request.
 * @returns {Promise<{deal?: object, created?: boolean, outcome?: object}>}
 * @throws {RetryLater} another conversation is creating the same driver
 */
async function whenNoDeal(thread, ctx, { identity, categoryId, stages }, deps, opts) {
  const asked = await proposals.listForRoot(thread.chatId, thread.rootMessageId);
  const skipped = asked.find((p) => p.kind === 'create_deal' && p.status === 'declined');
  // "Skip" means never — not even by the bot itself.
  if (skipped) return { outcome: { result: 'already_asked', proposalId: skipped.id } };
  if (!identity.ok) {
    ctx.note = identity.note;
    return {};
  }
  const made = await ensureCandidateDeal({
    chatId: thread.chatId, rootMessageId: thread.rootMessageId, identity, categoryId, stages,
  }, opts);
  if (made.status === 'busy') throw new RetryLater('another conversation is creating this driver in Bitrix');
  if (made.status === 'closed') return { outcome: { result: 'created_deal_closed', dealId: made.dealId } };
  if (made.status === 'blocked') {
    ctx.note = made.reason;
    return {};
  }
  await sayCreated(thread, deps, { ...made, driverName: identity.name, phone: identity.phone }, stages);
  return { deal: made.deal, created: made.status === 'created' };
}

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
  if (!verified.move) return done(thread, { result: verified.reason, model: answer.model });

  const identity = candidateIdentity({ postText, phones, modelName: verified.driverName });
  const name = verified.driverName || identity.name || null;
  if (name) seen.driverName = name;
  if (!lookup.deal && name) lookup = await findCandidateDeal({ name }, opts);
  if (lookup.status === 'ambiguous') {
    await notice(thread, deps, 'ambiguous', msg.ambiguousText({
      chatId: thread.chatId, rootMessageId: thread.rootMessageId, driverName: name, count: lookup.count,
    }));
    return done(thread, { result: 'ambiguous', people: lookup.count });
  }

  const ctx = {
    recruiter, phones, stage: verified.stage, driverName: name, evidence: verified.evidence, deal: null, note: null,
  };
  let deal = lookup.deal || null;
  if (!deal) {
    if (!name && !phones.length) return done(thread, { result: 'no_identity' });
    const missing = await whenNoDeal(thread, ctx, { identity, categoryId, stages }, deps, opts);
    if (missing.outcome) return done(thread, missing.outcome);
    deal = missing.deal || null;
    ctx.created = Boolean(missing.created);
  }
  if (deal) {
    const plan = await planForDeal(deal, verified.stage, { stages, categoryId }, opts);
    if (!plan.ok) return done(thread, { result: plan.reason, dealId: deal.id, ...(ctx.created ? { created: true } : {}) });
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
  await notice(thread, deps, `bitrix_error:${thread.revision}`, msg.bitrixErrorText({
    chatId: thread.chatId, rootMessageId: thread.rootMessageId, driverName: seen.driverName, error: stripUrls(err.message),
  }));
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
