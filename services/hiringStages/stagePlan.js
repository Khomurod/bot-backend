'use strict';

/**
 * Where a found deal should go, given the stage the conversation reached.
 *
 * Shared by the reviewer (a deal found while reading) and the "search again"
 * button (a deal the recruiter has just created). Stage ids belong to one
 * pipeline ("C3:NEW" is not "NEW"), so a stage read against one pipeline is
 * carried to the deal's own pipeline BY NAME — and when that pipeline has no
 * stage of that name, nothing is proposed.
 */

const bitrix = require('../bitrix24DealStages');
const { normaliseStages, stageByName, isForwardMove } = require('../../lib/hiringStages/proposal');

async function stagesFor(categoryId, opts) {
  return normaliseStages(await bitrix.listStageRows(categoryId, opts));
}

/**
 * @param {object} deal     from services/bitrix24DealStages.js
 * @param {{id: string, name: string}} wanted
 * @param {{stages?: object[], categoryId?: string}} [known]  stages already read, and their pipeline
 * @returns {Promise<{ok: true, target, current, stages} | {ok: false, reason: string, current}>}
 */
async function planForDeal(deal, wanted, known = {}, opts = {}) {
  const sameCategory = known.stages && String(known.categoryId ?? '0') === String(deal.categoryId ?? '0');
  const stages = sameCategory ? known.stages : await stagesFor(deal.categoryId, opts);
  const current = stages.find((s) => s.id === deal.stageId) || null;
  const target = stages.find((s) => s.id === wanted.id) || stageByName(stages, wanted.name);
  if (!target) return { ok: false, reason: 'pipeline_mismatch', current };
  if (target.id === deal.stageId) return { ok: false, reason: 'already_there', current };
  if (!isForwardMove(stages, deal.stageId, target)) return { ok: false, reason: 'backwards', current };
  return { ok: true, target, current, stages };
}

/** The proposal row's deal columns for a planned move. */
function dealColumns(deal, plan) {
  return {
    dealId: deal.id,
    dealTitle: deal.title,
    categoryId: String(deal.categoryId ?? '0'),
    fromStageId: deal.stageId,
    fromStageName: plan.current?.name || deal.stageId,
    toStageId: plan.target.id,
    toStageName: plan.target.name,
  };
}

module.exports = { stagesFor, planForDeal, dealColumns };
