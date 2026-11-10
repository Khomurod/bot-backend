'use strict';

/**
 * Settings → Dispatcher Board → Board ↔ Bitrix check: what the card shows and
 * what its switch does. The routes (server/routes/settings/boardBitrixRoutes.js)
 * only translate HTTP.
 *
 * COUNTS ONLY, like the Feed card beside it: how many differences of each
 * kind, whether a question is out and since when, and the last pass in
 * numbers. No driver name and no truck number — those belong in the question
 * in the group, not on a settings screen.
 *
 * Switching the check ON runs a pass at once (in the background), so the first
 * question does not wait for the next quarter of an hour. Switching it OFF puts
 * the question out back in line and atomically resets automatic sync to OFF.
 */

const { KIND_LABELS } = require('../../lib/boardBitrix/wording');

const SERVICE_KEY = 'board_bitrix_check';

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    store: require('../../database/boardBitrix'),
    schemaStore: require('../../database/boardBitrixSchema'),
    getRun: require('../../database/backgroundRuns').getRun,
    recentActions: require('../../database/boardBitrix').recentStageSyncActions,
    runNow: () => require('./timer').runNow(),
  };
  /* eslint-enable global-require */
}

function invalid(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const text = (value, max = 160) => (typeof value === 'string'
  ? value.replace(/\s+/g, ' ').trim().slice(0, max) : null);

function candidateView(candidate) {
  if (!candidate) return null;
  const labels = candidate.mapping?.labels || {};
  return {
    state: candidate.state,
    source: candidate.source,
    confidence: candidate.confidence,
    seenCount: candidate.seenCount,
    requiresApproval: candidate.requiresApproval,
    readyToApprove: candidate.state === 'candidate' && candidate.seenCount >= 2,
    problem: text(candidate.problem, 240),
    checkedAt: candidate.checkedAt,
    labels: {
      driverPipeline: text(labels.driverPipeline),
      truckProcess: text(labels.truckProcess),
      truckCategory: text(labels.truckCategory),
      activeTruckStages: (labels.activeTruckStages || []).map((v) => text(v)).filter(Boolean),
    },
    evidence: {
      totalTruckItems: num(candidate.evidence?.totalTruckItems),
      selectedCategoryItems: num(candidate.evidence?.selectedCategoryItems),
      selectedActiveItems: num(candidate.evidence?.selectedActiveItems),
    },
  };
}

function lastRunView(run) {
  if (!run) return null;
  const s = run.lastSummary || {};
  return {
    finishedAt: run.lastFinishedAt || null,
    status: run.lastStatus || null,
    error: run.lastError || null,
    boardDrivers: num(s.boardPeople),
    activeDeals: num(s.activeDeals),
    activeTrucks: num(s.activeTrucks),
    paired: num(s.paired),
    differences: num(s.discrepancies),
    syncMode: s.syncMode || 'off',
    syncCandidates: num(s.syncCandidates),
    syncIdentitySkipped: num(s.syncIdentitySkipped),
    syncPlanned: num(s.syncPlanned),
    syncApplied: num(s.syncApplied),
    syncFailed: num(s.syncFailed),
    syncBlocked: s.syncBlocked || null,
    schemaSource: s.schemaSource || null,
    schemaWriteSafe: s.schemaWriteSafe === true,
  };
}

async function getView({ deps = defaultDeps() } = {}) {
  const [settings, schemaState] = await Promise.all([
    deps.store.getSettings(),
    typeof deps.schemaStore?.getSchemaState === 'function'
      ? deps.schemaStore.getSchemaState() : Promise.resolve({ candidate: null }),
  ]);
  const summary = await deps.store.summarise();
  const current = summary.current;
  const recentActions = typeof deps.recentActions === 'function'
    ? await deps.recentActions(8) : [];
  const activeEvidence = settings.schemaMapping?.evidence || {};
  const proven = ['catalog_exact', 'ai_validated'].includes(settings.schemaSource)
    && num(activeEvidence.selectedActiveItems) > 0;
  const candidate = candidateView(schemaState.candidate);
  return {
    enabled: settings.enabled,
    syncMode: settings.syncMode || 'off',
    maxUpdatesPerPass: num(settings.maxUpdatesPerPass) || 10,
    schema: {
      source: settings.schemaSource || null,
      confidence: settings.schemaConfidence,
      checkedAt: settings.schemaCheckedAt,
      writeSafe: proven && !candidate,
      problem: candidate?.state === 'invalid' ? candidate.problem
        : settings.schemaSource === 'static_fallback' ? text(settings.schemaMapping?.problem, 240) : null,
      evidence: proven ? activeEvidence : null,
      candidate,
    },
    recentActions,
    updatedAt: settings.updatedAt,
    updatedBy: settings.updatedBy,
    counts: {
      waiting: num(summary.open) - num(summary.snoozed),
      skipped: num(summary.snoozed),
      asked: num(summary.asked),
      confirmed: num(summary.confirmed),
      fixedWithoutReply: num(summary.seen_fixed),
    },
    byKind: (summary.byKind || []).map((k) => ({ kind: k.kind, label: KIND_LABELS[k.kind] || k.kind, count: num(k.count) })),
    current: current ? { kind: current.kind, label: KIND_LABELS[current.kind] || current.kind, askedAt: current.askedAt } : null,
    lastRun: lastRunView(await deps.getRun(SERVICE_KEY)),
  };
}

async function setSyncSettings({ syncMode, maxUpdatesPerPass, confirmLive = false } = {}, {
  by = null, deps = defaultDeps(),
} = {}) {
  const mode = String(syncMode || '').trim();
  if (!['off', 'dry_run', 'live'].includes(mode)) throw invalid('syncMode must be off, dry_run or live');
  const max = Number(maxUpdatesPerPass);
  if (!Number.isInteger(max) || max < 1 || max > 25) throw invalid('maxUpdatesPerPass must be from 1 to 25');
  const current = await deps.store.getSettings();
  if (mode === 'live') {
    if (confirmLive !== true) throw invalid('Live Bitrix sync requires explicit confirmation');
    if (!current.enabled) throw invalid('Switch the Board ↔ Bitrix check on before live sync');
    const state = typeof deps.schemaStore?.getSchemaState === 'function'
      ? await deps.schemaStore.getSchemaState() : { candidate: null };
    if (!['catalog_exact', 'ai_validated'].includes(current.schemaSource)
      || num(current.schemaMapping?.evidence?.selectedActiveItems) < 1
      || state.candidate) {
      throw invalid('Run a successful dry check so the current Bitrix schema is validated before live sync');
    }
  }
  try {
    await deps.store.setSyncSettings({ syncMode: mode, maxUpdatesPerPass: max }, by);
  } catch (err) {
    if (err?.code === 'BOARD_BITRIX_CHECK_OFF') throw invalid(err.message);
    throw err;
  }
  if (mode !== 'off') Promise.resolve(deps.runNow()).catch(() => {});
  return getView({ deps });
}

async function approveSchema({ confirm = false } = {}, { by = null, deps = defaultDeps() } = {}) {
  if (confirm !== true) throw invalid('Schema approval requires explicit confirmation');
  const approved = await deps.schemaStore.approveCandidate(by);
  if (!approved) throw invalid('The schema candidate needs two recent matching checks before approval');
  Promise.resolve(deps.runNow()).catch(() => {});
  return getView({ deps });
}

async function setEnabled(enabled, { by = null, deps = defaultDeps() } = {}) {
  if (typeof enabled !== 'boolean') throw invalid('enabled must be true or false');
  await deps.store.setEnabled(enabled, by);
  // The store also atomically resets sync_mode to off. The question out goes
  // back in line, so switching on again asks it afresh instead of waiting
  // forever on a message far up the chat.
  if (!enabled) await deps.store.releaseQuestion();
  if (enabled) {
    Promise.resolve(deps.runNow()).catch((err) => console.warn('[BOARD-BITRIX] first pass failed:', err.message));
  }
  return getView({ deps });
}

/** One pass now, waited for. → { summary, settings } */
async function runNow({ deps = defaultDeps() } = {}) {
  const summary = await deps.runNow();
  return { summary, settings: await getView({ deps }) };
}

module.exports = {
  getView, setEnabled, setSyncSettings, approveSchema, runNow, lastRunView, SERVICE_KEY,
};
