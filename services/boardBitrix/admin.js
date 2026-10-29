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
 * the question out back in line.
 */

const { KIND_LABELS } = require('../../lib/boardBitrix/wording');

const SERVICE_KEY = 'board_bitrix_check';

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    store: require('../../database/boardBitrix'),
    getRun: require('../../database/backgroundRuns').getRun,
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
  };
}

async function getView({ deps = defaultDeps() } = {}) {
  const settings = await deps.store.getSettings();
  const summary = await deps.store.summarise();
  const current = summary.current;
  return {
    enabled: settings.enabled,
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

async function setEnabled(enabled, { by = null, deps = defaultDeps() } = {}) {
  if (typeof enabled !== 'boolean') throw invalid('enabled must be true or false');
  await deps.store.setEnabled(enabled, by);
  // Off: the question out goes back in line, so switching on again asks it
  // afresh instead of waiting forever on a message far up the chat.
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

module.exports = { getView, setEnabled, runNow, lastRunView, SERVICE_KEY };
