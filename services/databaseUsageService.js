'use strict';

/**
 * Keeps the monthly database-transfer estimate persisted and warns before the
 * hosted database's allowance runs out.
 *
 * WHY IT EXISTS. This deployment reached 4.222 GB of a 5 GB monthly transfer
 * allowance with nothing in the application aware of it. Exhausting that
 * allowance does not degrade gracefully — reads start failing, and until now
 * the app could not tell that apart from an outage. This service is the early
 * warning: it flushes the counters database/transferMeter.js accumulates and
 * logs once at 80%, 90% and 95% of the budget.
 *
 * IT NEVER BLOCKS ANYTHING. Nothing here can refuse a query or slow a request;
 * enforcement belongs to the provider, and silently throttling the app would
 * turn a warning into an outage of its own. It also does not touch billing or
 * change any provider setting.
 *
 * COST: one UPSERT of one row per minute, and one SELECT at boot.
 */

const config = require('../config/config');
const { flushUsage, loadPersistedUsage, reportThresholds, usageReport } = require('../database/transferUsage');

/** One write a minute is negligible; a longer gap risks losing a restart's counts. */
const FLUSH_MS = Number.parseInt(process.env.DB_USAGE_FLUSH_MS || '60000', 10);

let serviceTimer = null;
let tickRunning = false;

function budgetBytes() {
  return config.databaseTransferBudgetBytes;
}

/** Persist what has accumulated, then warn if a threshold was newly crossed. */
async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await flushUsage();
    reportThresholds({ budgetBytes: budgetBytes() });
  } catch (err) {
    // Accounting must never take the process down.
    console.warn('[DB-USAGE] tick failed:', err.message);
  } finally {
    tickRunning = false;
  }
}

/** The report the admin panel reads. Pure read of the in-memory counters. */
function currentUsage() {
  return usageReport({ budgetBytes: budgetBytes() });
}

function startDatabaseUsageService() {
  if (serviceTimer) return;
  // Adopt the stored total first, so a restart mid-month does not report 0%.
  void loadPersistedUsage()
    .then(() => reportThresholds({ budgetBytes: budgetBytes() }))
    .catch((err) => console.warn('[DB-USAGE] initial load failed:', err.message));

  serviceTimer = setInterval(() => { void tick(); }, FLUSH_MS);
  serviceTimer.unref?.();
  console.log(
    `[DB-USAGE] Transfer meter started (budget ${(budgetBytes() / (1024 ** 3)).toFixed(1)} GB/month, `
    + `flush every ${Math.round(FLUSH_MS / 1000)}s).`,
  );
}

/** Stop the timer and make a final best-effort flush. */
function stopDatabaseUsageService() {
  if (serviceTimer) {
    clearInterval(serviceTimer);
    serviceTimer = null;
  }
  return flushUsage().catch(() => ({ written: false }));
}

module.exports = {
  FLUSH_MS,
  startDatabaseUsageService,
  stopDatabaseUsageService,
  currentUsage,
  tick,
};
