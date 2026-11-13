'use strict';

/**
 * A person pressed a button on a proposal. ANYONE IN THE RECRUITING GROUP may
 * answer — the owner's choice (20 October 2026) — but only in that group, and
 * only once: the press CLAIMS the row (`pending → applying`), so a second
 * press finds it already answered.
 *
 *   ok  move the deal. The deal is READ AGAIN first: if somebody moved it by
 *       hand since the proposal, it is not moved (`stale`); if it is already
 *       there, nothing is written. Then the one write — crm.deal.update.
 *   no  leave it. That stage is never proposed again for this conversation.
 *   re  "I created the deal — search again": look the candidate up again; a
 *       deal found turns the same message into a Move / No proposal.
 *   rn / rk  ✏️ Rename a placeholder deal title / keep it — the same people,
 *       the same group; the rest is services/hiringStages/rename.js.
 *
 * Bitrix failing gives the claim back (`pending`) and says so to the presser
 * only; the group sees no error. Returns what to answer the press with.
 */

const proposals = require('../../database/hiringStages/proposals');
const { getSafetyApprovalSettings } = require('../../database/safetyApprovals/settings');
const bitrix = require('../bitrix24DealStages');
const { findCandidateDeal } = require('./dealFinder');
const { planForDeal, dealColumns, stagesFor } = require('./stagePlan');
const group = require('./groupMessages');
const { handleRenamePress } = require('./rename');

function personName(from) {
  if (!from) return null;
  const full = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  return full || (from.username ? `@${from.username}` : null);
}

const answer = (text, alert = false) => ({ text, alert });

async function bitrixFailed(proposal, err) {
  await proposals.transition(proposal.id, 'applying', 'pending', { error: String(err.message).slice(0, 300) });
  return answer(`Bitrix did not answer — nothing changed. Try again in a minute.\n${String(err.message).slice(0, 150)}`, true);
}

/**
 * Who pressed Move, and why — for Monitoring → Logs. The presser's Telegram
 * id is the evidence; the deal's title is the label (taken out after 60 days).
 */
function moveAudit(proposal, deal, by) {
  return {
    actorKind: 'person_button',
    actorTelegramId: by?.userId ?? null,
    actorName: by?.userName || null,
    trigger: 'hiring_stage.move',
    reason: 'Pressed Move on a stage proposal in the recruiting group (proposed from the conversation; the deal was read again first).',
    evidence: {
      proposalId: proposal.id, chatId: proposal.chatId, rootMessageId: proposal.rootMessageId,
    },
    targetLabel: deal?.title || proposal.dealTitle || null,
    change: [{
      field: 'STAGE_ID',
      from: proposal.fromStageName ? `${proposal.fromStageName} (${proposal.fromStageId})` : proposal.fromStageId,
      to: proposal.toStageName ? `${proposal.toStageName} (${proposal.toStageId})` : proposal.toStageId,
    }],
  };
}

async function confirmMove(proposal, by, deps) {
  let deal;
  try {
    deal = await bitrix.getDeal(proposal.dealId, deps.opts);
  } catch (err) {
    return bitrixFailed(proposal, err);
  }
  if (!deal) {
    const stale = await proposals.transition(proposal.id, 'applying', 'stale', { ...by, error: 'deal not found' });
    await group.closeProposal(deps.telegram, stale || proposal, 'gone');
    return answer('That deal no longer exists in Bitrix.', true);
  }
  if (deal.stageId === proposal.toStageId) {
    const done = await proposals.transition(proposal.id, 'applying', 'applied', by);
    await group.closeProposal(deps.telegram, done || proposal, 'already_there');
    return answer('Already at that stage — nothing to change.');
  }
  if (deal.stageId !== proposal.fromStageId) {
    let now = deal.stageId;
    try {
      now = (await stagesFor(deal.categoryId, deps.opts)).find((s) => s.id === deal.stageId)?.name || now;
    } catch { /* the id is still a fair answer */ }
    const stale = await proposals.transition(proposal.id, 'applying', 'stale', { ...by, error: `deal is at ${deal.stageId}` });
    await group.closeProposal(deps.telegram, stale || proposal, 'stale', { detail: now });
    return answer(`Not moved: the deal is now at ${now}.`, true);
  }
  try {
    await bitrix.moveDealToStage(proposal.dealId, proposal.toStageId, { ...deps.opts, audit: moveAudit(proposal, deal, by) });
  } catch (err) {
    return bitrixFailed(proposal, err);
  }
  const applied = await proposals.transition(proposal.id, 'applying', 'applied', by);
  await group.closeProposal(deps.telegram, applied || proposal, 'applied', { byName: by.userName });
  console.log(`[HIRING STAGES] proposal ${proposal.id}: deal ${proposal.dealId} moved by a group member`);
  return answer(`Done — moved to ${proposal.toStageName}.`);
}

async function searchAgain(proposal, deps) {
  let lookup;
  try {
    lookup = await findCandidateDeal({
      phones: proposal.driverPhone ? [proposal.driverPhone] : [],
      name: proposal.driverName,
    }, deps.opts);
  } catch (err) {
    return bitrixFailed(proposal, err);
  }
  if (lookup.status !== 'found') {
    await proposals.transition(proposal.id, 'applying', 'pending');
    return answer(lookup.status === 'ambiguous'
      ? `Found ${lookup.count} different people with that name — move the right deal by hand in Bitrix.`
      : 'Still no open deal for this driver in Bitrix.', true);
  }
  let plan;
  try {
    plan = await planForDeal(lookup.deal, { id: proposal.toStageId, name: proposal.toStageName }, {}, deps.opts);
  } catch (err) {
    return bitrixFailed(proposal, err);
  }
  if (!plan.ok) {
    const there = plan.reason === 'already_there';
    const closed = await proposals.transition(proposal.id, 'applying', there ? 'applied' : 'stale');
    const merged = { ...(closed || proposal), dealId: lookup.deal.id, dealTitle: lookup.deal.title };
    if (plan.reason === 'pipeline_mismatch') {
      await group.closeProposal(deps.telegram, merged, 'note', {
        detail: `Found "${lookup.deal.title || `deal ${lookup.deal.id}`}", but its pipeline has no `
          + `"${proposal.toStageName}" stage — move it by hand in Bitrix.`,
      });
      return answer('Found the deal, but its pipeline has no such stage.', true);
    }
    await group.closeProposal(deps.telegram, merged, there ? 'already_there' : 'stale', {
      detail: plan.current?.name || lookup.deal.stageId,
    });
    return answer(there ? 'Found it — it is already at that stage.' : 'Found it, but it is past that stage already.');
  }
  const moved = await proposals.attachDeal(proposal.id, dealColumns(lookup.deal, plan));
  if (moved) await group.refreshProposal(deps.telegram, moved);
  return answer('Found the deal — press Move to change its stage.');
}

/**
 * @param {{action: 'ok'|'no'|'re'|'rn'|'rk', proposalId: number, chatId: string|number,
 *   from: object}} press  for rn / rk, `proposalId` is the rename offer's id
 * @returns {Promise<{text: string, alert: boolean}>}
 */
async function handleStageButton(press, deps = {}) {
  const settings = await (deps.getSettings || getSafetyApprovalSettings)();
  if (!settings.enabled || !settings.stageProposalsEnabled || String(press.chatId) !== settings.chatId) {
    return answer('This button no longer works here.', true);
  }
  if (!press.from || press.from.is_bot) return answer('Only a person can answer this.', true);
  if (press.action === 'rn' || press.action === 'rk') {
    return handleRenamePress({ action: press.action, id: press.proposalId, chatId: press.chatId },
      { userId: press.from.id, userName: personName(press.from) },
      { telegram: deps.telegram, opts: { fetchImpl: deps.fetchImpl } });
  }

  const current = await proposals.getProposal(press.proposalId);
  if (!current || current.chatId !== String(press.chatId)) return answer('This proposal no longer exists.', true);
  const wantKind = press.action === 'ok' ? 'move' : press.action === 're' ? 'create_deal' : null;
  if (wantKind && current.kind !== wantKind) return answer('This proposal has changed — read it again.', true);

  const by = { userId: press.from.id, userName: personName(press.from) };
  const claimed = await proposals.transition(current.id, 'pending', 'applying', by);
  if (!claimed) return answer('Already answered.');

  const ctx = { telegram: deps.telegram, opts: { fetchImpl: deps.fetchImpl } };
  if (press.action === 'no') {
    const declined = await proposals.transition(claimed.id, 'applying', 'declined', by);
    await group.closeProposal(ctx.telegram, declined || claimed, 'declined', { byName: by.userName });
    return answer('OK — left as it is.');
  }
  if (press.action === 're') return searchAgain(claimed, ctx);
  return confirmMove(claimed, by, ctx);
}

module.exports = { handleStageButton, personName };
