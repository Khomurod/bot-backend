'use strict';

/**
 * The proposal step of one conversation's read: given a verified stage and
 * maybe a deal, post what follows in the Bitrix topic — "move X to STAGE?",
 * or, with no deal the bot could create, "please create it".
 *
 * ONE OPEN PROPOSAL PER CONVERSATION. A newer stage supersedes the open one
 * (its message is edited, its buttons go). A stage already proposed for the
 * deal — open, applied or declined — is never proposed again; a recruiter is
 * asked to create a deal once per conversation, and "Skip" means never.
 *
 * The proposal is RESERVED before it is sent (a unique index allows one open
 * proposal per conversation); a send Telegram refused marks it `unsent`.
 */

const threads = require('../../database/hiringStages/threads');
const proposals = require('../../database/hiringStages/proposals');
const { dealColumns } = require('./stagePlan');
const group = require('./groupMessages');

async function done(thread, outcome) {
  await threads.finishThread(thread, { status: 'done', outcome });
  return 'done';
}

/**
 * @param {object} thread  the queue row
 * @param {object} ctx     recruiter, phones, stage, driverName, evidence, deal, plan, note
 * @param {object} deps    telegram, settings
 * @returns {Promise<'done'|'retry'>}
 */
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
  } else {
    const asked = existing.find((p) => p.kind === 'create_deal' && ['pending', 'applying', 'declined'].includes(p.status));
    if (asked) return done(thread, { result: 'already_asked', proposalId: asked.id });
    row = {
      ...base, kind: 'create_deal', toStageId: ctx.stage.id, toStageName: ctx.stage.name, note: ctx.note || null,
    };
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
    const botMessageId = await group.sendProposal(deps.telegram, reserved, deps.settings?.bitrixTopicId);
    await proposals.recordSent(reserved.id, botMessageId);
  } catch (err) {
    await proposals.transition(reserved.id, 'pending', 'unsent', { error: String(err.message).slice(0, 300) });
    throw err;
  }
  return done(thread, {
    result: reserved.kind === 'move' ? 'proposed' : 'asked_to_create',
    proposalId: reserved.id,
  });
}

module.exports = { propose, done };
