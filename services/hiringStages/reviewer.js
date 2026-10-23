'use strict';

/**
 * Reading one candidate's conversation and, when it has moved on, proposing
 * the Bitrix stage — the work behind one queue row.
 *
 *   conversation → candidate post? → deal by phone → pipeline stages
 *     → model (redacted words) → verified stage → deal by name (if none yet)
 *     → "move X to STAGE?"  or  "no deal — recruiter, please create it"
 *
 * ONLY A CANDIDATE POST IS READ. The General topic also carries "the driver is
 * there" and "office is closed"; a candidate post carries a picture (the CDL)
 * or the driver's phone number. A post with neither is not a candidate, and
 * costs no model call.
 *
 * ONE OPEN PROPOSAL PER CONVERSATION. A newer stage supersedes the open one
 * (its message is edited, its buttons go). A stage already proposed for the
 * deal — open, applied or declined — is never proposed again; a recruiter is
 * asked to create a deal once per conversation, and "Skip" means never.
 *
 * Returns the queue status it left the row in; never throws for a failure it
 * can name (AI or Bitrix down → retry; after six attempts → gave_up).
 */

const threads = require('../../database/hiringStages/threads');
const proposals = require('../../database/hiringStages/proposals');
const conversation = require('../../lib/hiringStages/conversation');
const { verifyStageAnswer } = require('../../lib/hiringStages/proposal');
const { extractPhones } = require('../../lib/hiringStages/redact');
const { isImageDocument } = require('../../lib/safetyApprovals/messageShape');
const { getBitrixConfig } = require('../../database/bitrix');
const { BitrixError } = require('../bitrix24DealStages');
const { findCandidateDeal } = require('./dealFinder');
const { stagesFor, planForDeal, dealColumns } = require('./stagePlan');
const { readConversationStage, AiUnavailableError } = require('./aiReading');
const group = require('./groupMessages');

const RETRY_DELAYS_SECONDS = [60, 300, 900, 1800, 3600];
/** 1 + 5 + 15 + 30 + 60 minutes of trying; a new message in the conversation starts over. */
const MAX_ATTEMPTS = 6;

/** A candidate post carries a picture (the CDL) or a phone number to reach the driver on. */
function isCandidatePost(post) {
  return post.some((m) => m.photos?.length || (m.documents || []).some(isImageDocument)
    || extractPhones(m.text || '').length > 0);
}

async function done(thread, outcome) {
  await threads.finishThread(thread, { status: 'done', outcome });
  return 'done';
}

/** The proposal step: given a verified stage and maybe a deal, post what follows. */
async function propose(thread, ctx, deps) {
  const existing = await proposals.listForRoot(thread.chatId, thread.rootMessageId);
  if (existing.some((p) => p.status === 'applying')) {
    // Somebody is pressing a button on this conversation right now.
    await threads.retryThread(thread, { delaySeconds: 60, error: 'a proposal is being answered' });
    return 'retry';
  }
  const open = existing.find((p) => p.status === 'pending');
  const base = {
    chatId: thread.chatId,
    rootMessageId: thread.rootMessageId,
    driverName: ctx.driverName,
    driverPhone: ctx.phones[0] || null,
    evidence: ctx.evidence,
    // A post Safety forwarded is the recruiter's: ask them, not Safety.
    recruiterUserId: ctx.recruiter.forwardedFromUserId || (ctx.recruiter.forwardedFromName ? null : ctx.recruiter.fromUserId),
    recruiterName: ctx.recruiter.forwardedFromName || ctx.recruiter.fromName,
  };

  let row;
  let replyTo;
  if (ctx.deal) {
    const cols = dealColumns(ctx.deal, ctx.plan);
    const seen = existing.find((p) => p.kind === 'move' && p.dealId === cols.dealId && p.toStageId === cols.toStageId
      && ['pending', 'applying', 'applied', 'declined'].includes(p.status));
    if (seen) return done(thread, { result: 'already_proposed', proposalId: seen.id });
    // A re-read never replaces an open proposal for this deal with an EARLIER stage.
    const sortOf = (id) => ctx.plan.stages.find((st) => st.id === id)?.sort ?? -1;
    if (open?.kind === 'move' && open.dealId === cols.dealId && sortOf(open.toStageId) > sortOf(cols.toStageId)) {
      return done(thread, { result: 'already_proposed_further', proposalId: open.id });
    }
    row = { ...base, ...cols, kind: 'move' };
    replyTo = thread.lastMessageId;
  } else {
    const asked = existing.find((p) => p.kind === 'create_deal' && ['pending', 'applying', 'declined'].includes(p.status));
    if (asked) return done(thread, { result: 'already_asked', proposalId: asked.id });
    row = { ...base, kind: 'create_deal', toStageId: ctx.stage.id, toStageName: ctx.stage.name };
    replyTo = thread.rootMessageId;
  }

  if (open) {
    const superseded = await proposals.transition(open.id, 'pending', 'superseded');
    if (superseded) await group.closeProposal(deps.telegram, superseded, 'superseded');
  }
  const reserved = await proposals.reserveProposal(row);
  if (!reserved) {
    await threads.retryThread(thread, { delaySeconds: 60, error: 'another proposal opened meanwhile' });
    return 'retry';
  }
  try {
    const botMessageId = await group.sendProposal(deps.telegram, reserved, replyTo);
    await proposals.recordSent(reserved.id, botMessageId);
  } catch (err) {
    await proposals.transition(reserved.id, 'pending', 'unsent', { error: String(err.message).slice(0, 300) });
    throw err;
  }
  return done(thread, { result: reserved.kind === 'move' ? 'proposed' : 'asked_to_create', proposalId: reserved.id });
}

async function readAndPropose(thread, deps) {
  const { settings } = deps;
  const messages = await threads.listThreadMessages(thread.chatId, thread.rootMessageId);
  const post = conversation.postMessages(messages, thread.rootMessageId);
  if (!post.length) return done(thread, { result: 'no_post' });
  if (!conversation.hasReplies(messages, thread.rootMessageId)) return done(thread, { result: 'no_conversation' });
  if (!isCandidatePost(post)) return done(thread, { result: 'not_a_candidate_post' });

  const recruiter = post[0];
  const opts = { fetchImpl: deps.fetchImpl };
  const phones = conversation.candidatePhones(messages, { rootMessageId: thread.rootMessageId, safetyUserIds: settings.safetyUserIds });
  let lookup = phones.length ? await findCandidateDeal({ phones }, opts) : { status: 'none' };

  const categoryId = lookup.deal?.categoryId ?? ((await getBitrixConfig()).dealCategoryId || '0');
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

  if (!lookup.deal && verified.driverName) lookup = await findCandidateDeal({ name: verified.driverName }, opts);
  if (lookup.status === 'ambiguous') return done(thread, { result: 'ambiguous', people: lookup.count });

  const ctx = {
    recruiter, phones, stage: verified.stage, driverName: verified.driverName, evidence: verified.evidence, deal: null,
  };
  if (lookup.deal) {
    const plan = await planForDeal(lookup.deal, verified.stage, { stages, categoryId }, opts);
    if (!plan.ok) return done(thread, { result: plan.reason, dealId: lookup.deal.id });
    Object.assign(ctx, { deal: lookup.deal, plan });
  } else if (!verified.driverName && !phones.length) {
    return done(thread, { result: 'no_identity' });
  }
  return propose(thread, ctx, deps);
}

function retryable(err) {
  if (err instanceof AiUnavailableError) return true;
  if (err instanceof BitrixError) return err.retryable;
  return true;
}

/** @returns {Promise<'done'|'retry'|'gave_up'>} */
async function processThread(thread, deps) {
  try {
    return await readAndPropose(thread, deps);
  } catch (err) {
    const error = String(err?.message || err).slice(0, 300);
    if (!retryable(err)) {
      await threads.finishThread(thread, { status: 'done', outcome: { result: 'bitrix_error' }, error });
      return 'done';
    }
    if (thread.attempts >= MAX_ATTEMPTS) {
      await threads.finishThread(thread, { status: 'gave_up', error });
      return 'gave_up';
    }
    const delay = RETRY_DELAYS_SECONDS[Math.min(thread.attempts - 1, RETRY_DELAYS_SECONDS.length - 1)];
    await threads.retryThread(thread, { delaySeconds: delay, error });
    return 'retry';
  }
}

module.exports = { processThread, isCandidatePost, MAX_ATTEMPTS, RETRY_DELAYS_SECONDS };
