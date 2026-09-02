/**
 * Mileage-bonus RUN STATE — the in-process lock, with one owner.
 *
 * `activeRun` is a promise lock so a manual run and the weekly scheduled run can
 * never overlap, and `runTracked` is the only writer of it. The database lease
 * (`mileage_bonus_runs`, unique run_key) is the cross-restart guard; this is the
 * within-process one. Both matter: dropping either lets one milestone be
 * announced twice, which is real money.
 *
 * Split out of services/mileageBonusService.js, which re-exports isRunning and
 * isRunActive.
 */
const mb = require('../../database/mileageBonus');
const { makeRunKey, retryDelayMinutes } = require('./runHelpers');

let activeRun = null; // Promise lock so manual + scheduled runs never overlap.

let lastRunSummary = null;

async function runTracked({ trigger, mode, runKey, requestedBy }, task) {
  if (activeRun) return { busy: true };

  const operation = mb.withMileageRunLock(async () => {
    const claimedRun = await mb.claimMileageBonusRun({
      runKey: runKey || makeRunKey(trigger, mode),
      trigger,
      mode,
      requestedBy,
    });
    if (!claimedRun) return { skipped: true, reason: 'already_completed_or_retry_not_due' };

    try {
      const result = await task(claimedRun);
      lastRunSummary = result;
      await mb.completeMileageBonusRun(claimedRun.id, result);
      return result;
    } catch (err) {
      if (err.summary) lastRunSummary = err.summary;
      await mb.failMileageBonusRun(
        claimedRun.id,
        err.message,
        retryDelayMinutes(claimedRun.attempt_count),
        err.summary || null
      ).catch(() => {});
      throw err;
    }
  });

  activeRun = operation;
  try {
    const locked = await operation;
    return locked.acquired ? locked.result : { busy: true };
  } finally {
    activeRun = null;
  }
}

function isRunning() {
  return Boolean(activeRun);
}

async function isRunActive() {
  return Boolean(activeRun) || mb.isMileageBonusRunActive();
}

/** The last completed run's summary, for the admin overview. */
function getLastRunSummary() {
  return lastRunSummary;
}

/**
 * Record a run's outcome. runTracked() already does this for the runs it wraps;
 * a caller that produced a summary of its own reports it here so the overview
 * and the lock never disagree about the latest run.
 */
function setLastRunSummary(summary) {
  lastRunSummary = summary;
}

module.exports = {
  runTracked,
  setLastRunSummary,
  isRunning,
  isRunActive,
  getLastRunSummary,
};
