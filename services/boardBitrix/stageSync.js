'use strict';

/**
 * Guarded Dispatcher Board -> Bitrix STAGE_ID writes.
 *
 * AI is not on this path. It may have helped map labels to live ids, but the
 * schema has already been validated against Bitrix before this sees it. Every
 * update is one exact deal, one exact before stage, one exact target stage.
 */
const crypto = require('node:crypto');
const { namesAgreeStrictly } = require('../../lib/identity/boardResolution');
const { normalizeBoardTruck } = require('../../lib/board/truck');
const { attemptFromError } = require('../../lib/activityLog/entry');

const CONFIRM_MINUTES = 20;
const MAX_ALLOWED_UPDATES = 25;

function defaultDeps() {
  /* eslint-disable global-require */
  const store = require('../../database/boardBitrix');
  return {
    call: require('../bitrix24DealStages').callBitrix,
    recordPlan: store.recordPlannedStageSync,
    claim: store.claimStageSync,
    finish: store.finishStageSync,
    confirmBoardStatus: store.confirmBoardStatus,
    isLiveEnabled: store.isLiveSyncEnabled,
    attemptOf: store.stageSyncAttempt,
    logAttempt: (attempt) => require('../activityLog/record').recordAttempt(attempt),
    now: () => Date.now(),
  };
  /* eslint-enable global-require */
}

/**
 * The comparison's fuzzy name tolerance is right for suppressing noisy
 * questions, but it is not identity proof for a write. Automatic status sync
 * requires two independent exact facts: a strict name and the same
 * (fleet, exact unit spelling). Anything less remains a human question.
 */
function writeSafeIdentity(discrepancy) {
  const board = discrepancy?.board || {};
  const deal = discrepancy?.deal || {};
  const boardTruck = normalizeBoardTruck(board.truck);
  const bitrixTruck = normalizeBoardTruck(deal.truckNumber);
  return Boolean(
    namesAgreeStrictly(board.name, deal.title)
    && board.fleetType
    && board.fleetType === deal.fleetType
    && boardTruck
    && bitrixTruck
    && boardTruck === bitrixTruck
  );
}

/**
 * A status time as epoch ms, to the MILLISECOND. The Board snapshot comes from
 * PostgreSQL as a Date; `Date.parse(date)` would go through `String(date)`,
 * which has no milliseconds — the plan then carried "…:09.000Z" while the row
 * says "…:09.647", `confirmBoardStatus` never matched, and every live update
 * from 11 November 2026 stopped itself with "the Dispatcher Board status
 * changed after the comparison" (157 attempts on one deal).
 */
function timeMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Date.parse(value);
}

function actionKey(mode, item) {
  const event = item.statusChangedAt || 'no-event-time';
  const raw = `${mode}|${item.dealId}|${item.beforeStageId || ''}|${item.targetStageId}|${item.boardStatus}|${event}`;
  return `stage:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

function planStageUpdates(discrepancies, schema, {
  now = Date.now(), confirmMinutes = CONFIRM_MINUTES, maxUpdates = 10,
} = {}) {
  const candidates = [];
  const seen = new Set();
  let settling = 0;
  let unsafeIdentity = 0;
  for (const d of discrepancies || []) {
    if (d?.kind !== 'status_differs') continue;
    const dealId = Number(d.deal?.id);
    const beforeStageId = d.deal?.stageId ? String(d.deal.stageId) : null;
    const targetStageId = d.expectedStageId ? String(d.expectedStageId) : null;
    const boardStatus = String(d.board?.status || '').trim().toUpperCase();
    const statusChangedAt = d.board?.statusChangedAt || null;
    const rowKey = d.board?.rowKey || null;
    if (!dealId || !beforeStageId || !targetStageId || !boardStatus || seen.has(dealId)) continue;
    if (!Object.values(schema?.stageByRole || {}).includes(targetStageId)) continue;
    const changedMs = timeMs(statusChangedAt);
    if (!Number.isFinite(changedMs) || now - changedMs < confirmMinutes * 60000) {
      settling += 1;
      continue;
    }
    if (!rowKey || !writeSafeIdentity(d)) {
      unsafeIdentity += 1;
      continue;
    }
    seen.add(dealId);
    candidates.push({
      discrepancyKey: d.key,
      dealId,
      rowKey,
      boardStatus,
      statusChangedAt: new Date(changedMs).toISOString(),
      beforeStageId,
      targetStageId,
      schemaFingerprint: schema?.fingerprint || null,
      dealTitle: d.deal?.title || null,
    });
  }
  const cap = Math.min(MAX_ALLOWED_UPDATES, Math.max(1, Number(maxUpdates) || 10));
  if (candidates.length > cap) {
    return {
      candidates: [], totalCandidates: candidates.length, settling, unsafeIdentity,
      blocked: `${candidates.length} stage changes exceed the per-pass safety limit of ${cap}`,
    };
  }
  return {
    candidates, totalCandidates: candidates.length, settling, unsafeIdentity, blocked: null,
  };
}

function categoryOf(deal) {
  return Number(deal?.CATEGORY_ID ?? deal?.categoryId);
}

function stageOf(deal) {
  return String(deal?.STAGE_ID ?? deal?.stageId ?? '');
}

function closed(deal) {
  return deal?.CLOSED === 'Y' || deal?.closed === true || deal?.STAGE_SEMANTIC_ID === 'F';
}

/**
 * Why this write, for Monitoring → Logs: automatic, the Board's status and
 * when it changed, the exact transition. Ids only — never the Board row's key
 * (it names the person); the deal's title is the label (taken out after 60
 * days). Every attempt of one transition shares `correlationKey`.
 */
function auditFor(item, key, attempt) {
  return {
    actorKind: 'automatic',
    trigger: 'board_bitrix.sync',
    reason: `The Dispatcher Board says ${item.boardStatus} since ${item.statusChangedAt}; `
      + 'the live status sync moves the deal to the stage that status maps to.',
    evidence: {
      boardStatus: item.boardStatus,
      boardStatusChangedAt: item.statusChangedAt,
      actionKey: key,
      schemaFingerprint: item.schemaFingerprint || null,
    },
    targetLabel: item.dealTitle || null,
    change: [{ field: 'STAGE_ID', from: item.beforeStageId, to: item.targetStageId }],
    correlationKey: key,
    attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : null,
  };
}

/** One attempt that never reached Bitrix's write, in the same timeline. Never throws. */
async function logAttempt(deps, item, audit, outcome) {
  if (typeof deps.logAttempt !== 'function') return;
  await Promise.resolve(deps.logAttempt({
    action: 'deal.stage', targetId: item.dealId, audit, ...outcome,
  })).catch(() => {});
}

/**
 * A SAFETY CHECK of this loop saying no — nothing is sent to Bitrix. Marked,
 * so it is recorded as `refused` by a safety check, and anything else thrown
 * before the write (the re-read getting no answer, the database failing) is
 * what it is: `failed`, or `refused` when Bitrix itself said no.
 */
function guardRefusal(message) {
  return Object.assign(new Error(message), { guard: true });
}

/** How an attempt that threw before or after its write is recorded. */
function outcomeOf(err, phase) {
  if (phase === 'before' && err?.guard === true) return { result: 'refused', error: err.message, safetyCheck: true };
  // After a done write: the verification read disagreed or failed.
  if (phase === 'after') return { result: 'failed', error: err?.message, safetyCheck: false };
  return attemptFromError(err);
}

async function liveStillEnabled(deps) {
  return typeof deps.isLiveEnabled === 'function' && await deps.isLiveEnabled() === true;
}

async function runStageSync({
  discrepancies, schema, mode = 'off', maxUpdates = 10, deps = defaultDeps(),
} = {}) {
  const summary = {
    mode, candidates: 0, settling: 0, planned: 0, applied: 0,
    identitySkipped: 0, alreadyDone: 0, failed: 0, errors: [], resolvedKeys: [],
  };
  if (mode === 'off') return summary;
  if (!['dry_run', 'live'].includes(mode)) return { ...summary, blocked: 'unknown Bitrix sync mode' };
  if (!schema?.writeSafe) {
    return { ...summary, blocked: schema?.problem || 'the current Bitrix schema was not validated, so status sync is blocked' };
  }

  const plan = planStageUpdates(discrepancies, schema, {
    now: deps.now(), maxUpdates,
  });
  summary.candidates = plan.totalCandidates;
  summary.settling = plan.settling;
  summary.identitySkipped = plan.unsafeIdentity;
  if (plan.blocked) return { ...summary, blocked: plan.blocked };
  for (const item of plan.candidates) {
    const key = actionKey(mode, item);
    if (mode === 'dry_run') {
      try {
        // eslint-disable-next-line no-await-in-loop
        if (await deps.recordPlan({ ...item, actionKey: key })) summary.planned += 1;
      } catch (err) {
        summary.errors.push(`deal ${item.dealId}: the dry-run audit could not be recorded`);
      }
      continue;
    }

    let claimId = null;
    let audit = auditFor(item, key, null);
    // 'before' until the write is sent, 'write' while it is (the client
    // records that), 'after' for the verification read.
    let phase = 'before';
    try {
      // The settings snapshot that started this pass is not permission forever:
      // an administrator may have pressed Off while the comparison was running.
      // eslint-disable-next-line no-await-in-loop
      if (!await liveStillEnabled(deps)) {
        summary.blocked = 'live sync was switched off while this pass was running';
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      claimId = await deps.claim({ ...item, actionKey: key });
      if (!claimId) continue;
      if (typeof deps.attemptOf === 'function') {
        // eslint-disable-next-line no-await-in-loop
        audit = auditFor(item, key, await Promise.resolve(deps.attemptOf(claimId)).catch(() => null));
      }
      // Re-read after the database claim. A person or a Bitrix robot may have
      // moved the deal since the comparison; that is never overwritten.
      // eslint-disable-next-line no-await-in-loop
      const before = await deps.call('crm.deal.get', { id: item.dealId });
      if (categoryOf(before) !== Number(schema.categoryId)) throw guardRefusal('the deal is no longer in the discovered driver pipeline');
      if (closed(before)) throw guardRefusal('the deal is closed');
      if (typeof deps.confirmBoardStatus !== 'function'
        // eslint-disable-next-line no-await-in-loop
        || !await deps.confirmBoardStatus(item)) {
        throw guardRefusal('the Dispatcher Board status changed after the comparison');
      }
      if (stageOf(before) === item.targetStageId) {
        // eslint-disable-next-line no-await-in-loop
        await deps.finish(claimId, 'already_done');
        // eslint-disable-next-line no-await-in-loop
        await logAttempt(deps, item, audit, { result: 'already_done' });
        summary.alreadyDone += 1;
        summary.resolvedKeys.push(item.discrepancyKey);
        continue;
      }
      if (stageOf(before) !== item.beforeStageId) throw guardRefusal('the deal stage changed after the comparison');

      // Re-read the kill switch after every other precondition and immediately
      // before the external mutation. A database flag cannot atomically cancel
      // a request already accepted by Bitrix, so this is the narrowest boundary.
      // eslint-disable-next-line no-await-in-loop
      if (!await liveStillEnabled(deps)) throw guardRefusal('live sync was switched off before the Bitrix update');

      // The only mutation: STAGE_ID, with a Bitrix timeline event.
      phase = 'write';
      // eslint-disable-next-line no-await-in-loop
      const updated = await deps.call('crm.deal.update', {
        id: item.dealId,
        fields: { STAGE_ID: item.targetStageId },
        params: { REGISTER_SONET_EVENT: 'Y' },
      }, { audit });
      if (updated !== true) throw new Error('Bitrix did not confirm the stage update');
      phase = 'after';

      // eslint-disable-next-line no-await-in-loop
      const after = await deps.call('crm.deal.get', { id: item.dealId });
      if (stageOf(after) !== item.targetStageId) throw new Error('Bitrix returned a different stage after the update');
      // eslint-disable-next-line no-await-in-loop
      await deps.finish(claimId, 'applied');
      summary.applied += 1;
      summary.resolvedKeys.push(item.discrepancyKey);
    } catch (err) {
      summary.failed += 1;
      summary.errors.push(`deal ${item.dealId}: ${String(err.message).slice(0, 160)}`);
      // The client recorded the write itself; a safety check's refusal or a
      // failed read before it, and a verification that failed after it, are
      // recorded here (`outcomeOf`).
      if (phase !== 'write') {
        // eslint-disable-next-line no-await-in-loop
        await logAttempt(deps, item, audit, outcomeOf(err, phase));
      }
      if (claimId) {
        // eslint-disable-next-line no-await-in-loop
        await deps.finish(claimId, 'failed', err.message).catch(() => {});
      }
    }
  }
  return summary;
}

module.exports = {
  CONFIRM_MINUTES, MAX_ALLOWED_UPDATES, actionKey, writeSafeIdentity, planStageUpdates,
  runStageSync, defaultDeps, auditFor, __test: {
    categoryOf, stageOf, closed, liveStillEnabled, timeMs, outcomeOf,
  },
};
