'use strict';

/**
 * What a conversation's read does when Bitrix shows NO OPEN DEAL for the
 * candidate — the step between "no deal found" and either a created deal or
 * a "please create it" request (services/hiringStages/reviewer.js).
 *
 * In this order, each one ending the step:
 *
 *   1. Skip pressed on an earlier request means never — not even by the bot.
 *   2. THE CONVERSATION'S OWN DEAL (owner, 13–14 November 2026). A deal this
 *      conversation already knows — on one of its proposals, or the one the
 *      bot created for it — is read again (read only). Still there and open:
 *      it is the deal. Still there and CLOSED (moved to Lost by a person):
 *      nothing is created and nobody is asked to create one; one line on the
 *      card says so. A re-read of a conversation whose deal was moved to Lost
 *      asked people to "create the deal", and could have created a second.
 *   3. REJECTED (owner decision g): Safety's newest hashtag is #NotApproved,
 *      or the stage read is a failure (lost) stage — nothing is created and
 *      nobody is asked; one line on the card says so.
 *   4. Not certain who the candidate is → the reason, for the request.
 *   5. Otherwise CREATE the contact and deal (crmCreate.js).
 */

const proposals = require('../../database/hiringStages/proposals');
const records = require('../../database/hiringStages/crmRecords');
const msg = require('../../lib/hiringStages/messages');
const bitrix = require('../bitrix24DealStages');
const { ensureCandidateDeal } = require('./crmCreate');
const { stagesFor } = require('./stagePlan');
const group = require('./groupMessages');

/** Deals read per conversation at most — a conversation knows one or two. */
const MAX_KNOWN = 3;

/** Not a failure — somebody else's step must finish first. Retried on the same schedule. */
class RetryLater extends Error {}

/** A line of news on the driver's card in the Bitrix topic, once per key. */
const notice = (thread, deps, key, line, driverName) => group.sendNotice(deps.telegram, deps.settings?.bitrixTopicId, {
  chatId: thread.chatId, rootMessageId: thread.rootMessageId, driverName, key, line,
});

/** "Created a deal for X" — once per conversation, whichever read finished the creation. */
async function sayCreated(thread, deps, made, stages) {
  if (made?.status !== 'created') return;
  await notice(thread, deps, 'created', msg.createdLine({
    dealId: made.deal.id,
    dealTitle: made.deal.title,
    dealUrl: await bitrix.dealUrl(made.deal.id),
    stageName: stages.find((s) => s.id === made.deal.stageId)?.name || made.deal.stageId,
    contactReused: made.contactReused,
  }), made.driverName);
}

/** The deal ids this conversation already knows, newest first. */
async function knownDealIds(thread, asked) {
  const record = await records.getForRoot(thread.chatId, thread.rootMessageId);
  const ids = [...asked.map((p) => p.dealId), record?.dealId].filter((id) => Number(id) > 0).map(Number);
  return [...new Set(ids)].slice(0, MAX_KNOWN);
}

/**
 * @returns {Promise<{deal?: object, closed?: object}>} an open deal of the
 *   conversation's own, else a closed one, else nothing
 */
async function knownDeal(thread, asked, opts) {
  let closed = null;
  for (const id of await knownDealIds(thread, asked)) {
    // eslint-disable-next-line no-await-in-loop
    const deal = await bitrix.getDeal(id, opts);
    if (deal && !deal.closed) return { deal };
    if (deal && !closed) closed = deal;
  }
  return closed ? { closed } : {};
}

async function sayClosed(thread, deps, deal, driverName, opts) {
  let stageName = deal.stageId;
  try {
    stageName = (await stagesFor(deal.categoryId, opts)).find((s) => s.id === deal.stageId)?.name || stageName;
  } catch { /* the id is still a fair answer */ }
  await notice(thread, deps, `deal_closed:${deal.id}`, msg.closedDealLine({
    dealId: deal.id, dealTitle: deal.title, dealUrl: await bitrix.dealUrl(deal.id), stageName,
  }), driverName);
}

/**
 * No open deal was found. Use the conversation's own, say it is closed or the
 * candidate rejected, create one when the candidate is certain — or leave the
 * reason for the "please create it" request.
 * @param {object} args
 * @param {object} args.identity     lib/hiringStages/identity.js
 * @param {boolean} args.rejected    Safety's #NotApproved, or a lost stage
 * @returns {Promise<{deal?: object, created?: boolean, outcome?: object}>}
 * @throws {RetryLater} another conversation is creating the same driver
 */
async function whenNoDeal(thread, ctx, {
  identity, categoryId, stages, rejected = false,
}, deps, opts) {
  const asked = await proposals.listForRoot(thread.chatId, thread.rootMessageId);
  const skipped = asked.find((p) => p.kind === 'create_deal' && p.status === 'declined');
  // "Skip" means never — not even by the bot itself.
  if (skipped) return { outcome: { result: 'already_asked', proposalId: skipped.id } };

  const own = await knownDeal(thread, asked, opts);
  if (own.deal) return { deal: own.deal };
  if (own.closed) {
    await sayClosed(thread, deps, own.closed, ctx.driverName, opts);
    return { outcome: { result: 'known_deal_closed', dealId: own.closed.id } };
  }
  if (rejected) {
    await notice(thread, deps, 'rejected_no_deal', msg.rejectedLine(), ctx.driverName);
    return { outcome: { result: 'rejected_no_deal' } };
  }
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

module.exports = {
  whenNoDeal, sayCreated, notice, RetryLater,
};
