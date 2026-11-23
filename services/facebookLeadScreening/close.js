'use strict';

/**
 * Closing a screened-out Facebook lead's deal as Lost, with the reason the
 * form answers give (the owner, 23 November 2026; the rules are in ./rules.js,
 * the portal's ids in config/facebookLeadScreening.json).
 *
 * WHICH DEAL. In this Simple-CRM portal the bot creates a Bitrix LEAD and
 * Bitrix converts it into a deal in the hiring pipeline moments later (see
 * services/bitrix24Service.js `getConvertedDealAssignee`), so the deal is found
 * by its LEAD_ID backlink, asked again for a bounded while. When leads are
 * created as deals directly (entity `deal`) the record IS the deal.
 *
 * WHAT IT WILL NOT DO:
 *   - move a deal that is not in the hiring pipeline at New Lead or
 *     Contacting — a person who already took it further decides, not a form
 *     answer (recorded as a safety check, nothing sent to Bitrix);
 *   - move it twice: a deal already Lost is `already_done`, so a re-driven
 *     lead event changes nothing;
 *   - throw. Every outcome is returned; the lead's Telegram post and `leads`
 *     row have already happened and must not be undone by this step.
 *
 * Every write goes through the recording client (`callBitrix`) with an audit
 * context, and every attempt that ends before its write is an entry too
 * (Monitoring → Logs, docs/architecture/activity-log.md).
 */

const settings = require('../../config/facebookLeadScreening.json');
const { attemptFromError } = require('../../lib/activityLog/entry');
const { primaryReason, dealComment } = require('./rules');

const TRIGGER = 'facebook_lead.screening';
const DEAL_POLL_ATTEMPTS = 6;
const DEAL_POLL_INTERVAL_MS = 5000;
const REASON_LABELS = Object.freeze({
  no_cdl_a: 'No CDL Class A',
  experience: 'Insufficient experience',
  record: 'Bad record',
  contract_1099: 'Other (not OK with 1099 OTR)',
});

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    bitrix: require('../bitrix24DealStages').callBitrix,
    recordAttempt: require('../activityLog/record').recordAttempt,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
  };
  /* eslint-enable global-require */
}

function isEnabled() {
  return settings.enabled !== false;
}

/** Monitoring → Logs: automatic, from the form answers. Ids in the evidence; the name is the label. */
function auditFor({ leadgenId, formId, leadName, reason, fromStage }) {
  return {
    actorKind: 'automatic',
    trigger: TRIGGER,
    reason: 'The candidate answered No to a must-have question on the Facebook lead form.',
    evidence: { leadgenId: String(leadgenId || ''), formId: formId || null, rule: reason },
    targetLabel: leadName || null,
    change: [
      { field: 'STAGE_ID', from: fromStage || null, to: settings.lostStageId },
      { field: settings.lostReasonField, from: null, to: REASON_LABELS[reason] || reason },
    ],
  };
}

/** The deal the lead became, as Bitrix sends it ({ID, STAGE_ID, CATEGORY_ID}), or null. Throws what Bitrix throws. */
async function findDeal(bitrixResult, deps, { attempts, intervalMs }) {
  const select = ['ID', 'STAGE_ID', 'CATEGORY_ID'];
  if (bitrixResult.entity === 'deal') {
    const rows = await deps.bitrix('crm.deal.list', {
      filter: { ID: Number(bitrixResult.bitrixId) }, select,
    });
    return Array.isArray(rows) && rows[0]?.ID ? rows[0] : null;
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (attempt) await deps.sleep(intervalMs);
    // eslint-disable-next-line no-await-in-loop
    const rows = await deps.bitrix('crm.deal.list', {
      filter: { LEAD_ID: Number(bitrixResult.bitrixId) }, select, order: { ID: 'DESC' },
    });
    if (Array.isArray(rows) && rows[0]?.ID) return rows[0];
  }
  return null;
}

/**
 * @param {object} args
 * @param {{ok: boolean, bitrixId?: *, entity?: string}|null} args.bitrixResult  what createCrmRecordFromLead answered
 * @param {{failed: Array<{reason: string}>}} args.screening  ./rules.js screenLeadAnswers
 * @returns {Promise<{closed: boolean, already?: boolean, dealId?: number, why?: string}>}
 */
async function closeScreenedOutLead({
  bitrixResult, screening, leadgenId, formId = null, leadName = null,
  deps = defaultDeps(), attempts = DEAL_POLL_ATTEMPTS, intervalMs = DEAL_POLL_INTERVAL_MS,
}) {
  if (!isEnabled()) return { closed: false, why: 'switched off' };
  if (!bitrixResult?.ok || !bitrixResult.bitrixId) return { closed: false, why: 'the lead is not in Bitrix' };
  const reason = primaryReason(screening);
  const reasonId = settings.lostReasons[reason];
  if (!reasonId) return { closed: false, why: 'no Bitrix lost reason for this answer' };

  const base = { leadgenId, formId, leadName, reason };
  const logAttempt = (targetId, fromStage, outcome) => deps.recordAttempt({
    action: 'deal.stage',
    targetType: targetId === 'lead' ? 'lead' : 'deal',
    targetId: targetId === 'lead' ? bitrixResult.bitrixId : targetId,
    audit: auditFor({ ...base, fromStage }),
    ...outcome,
  });

  let deal;
  try {
    deal = await findDeal(bitrixResult, deps, { attempts, intervalMs });
  } catch (err) {
    await logAttempt('lead', null, attemptFromError(err));
    return { closed: false, why: 'Bitrix did not answer when the deal was looked up' };
  }
  if (!deal) {
    await logAttempt('lead', null, { result: 'failed', error: 'the lead had not become a deal yet', safetyCheck: false });
    return { closed: false, why: 'the lead had not become a deal yet' };
  }

  const dealId = Number(deal.ID);
  const stage = String(deal.STAGE_ID || '');
  const inPipeline = String(deal.CATEGORY_ID ?? '') === String(settings.pipelineId);
  if (inPipeline && stage === settings.lostStageId) {
    await logAttempt(dealId, stage, { result: 'already_done', error: 'the deal was already Lost' });
    return { closed: false, already: true, dealId };
  }
  if (!inPipeline || !settings.openStageIds.includes(stage)) {
    await logAttempt(dealId, stage, { result: 'refused', error: 'a person had already moved the deal on' });
    return { closed: false, dealId, why: 'a person had already moved the deal on' };
  }

  const audit = auditFor({ ...base, fromStage: stage });
  try {
    const ok = await deps.bitrix('crm.deal.update', {
      id: dealId,
      fields: { STAGE_ID: settings.lostStageId, [settings.lostReasonField]: reasonId },
      params: { REGISTER_SONET_EVENT: 'Y' },
    }, { audit });
    if (ok !== true) return { closed: false, dealId, why: 'Bitrix did not confirm the change' };
  } catch (err) {
    // Recorded by the client already (err.activityRecorded).
    return { closed: false, dealId, why: `Bitrix refused the change: ${String(err?.message || err).slice(0, 120)}` };
  }

  try {
    await deps.bitrix('crm.timeline.comment.add', {
      fields: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal', COMMENT: dealComment(screening, formId) },
    }, { audit: { ...audit, change: [{ field: 'timeline comment', from: null, to: 'why it was closed' }] } });
  } catch (_) {
    // The deal IS closed; a missing note is recorded by the client and is not worth failing for.
  }
  return { closed: true, dealId };
}

module.exports = {
  TRIGGER,
  REASON_LABELS,
  isEnabled,
  closeScreenedOutLead,
  __test: { findDeal, auditFor },
};
