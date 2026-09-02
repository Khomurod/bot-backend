/**
 * 75¢-milestone Mileage Bonus — service façade + weekly scheduler.
 *
 * Detects when a driver crosses a mileage milestone and posts a bonus card for
 * accounting to act on. This file owns only the service LIFECYCLE — the weekly
 * Wednesday 07:00 Central wake that index.js starts and stops — and re-exports
 * the public surface so existing importers are unchanged:
 *
 *   ./mileageBonus/runHelpers.js         PURE run-key/backoff/order helpers
 *   ./mileageBonus/runState.js           the in-process run lock, single owner
 *   ./mileageBonus/mileageComputation.js cumulative miles per driver
 *   ./mileageBonus/notificationCards.js  the Telegram card and its dedupe
 *   ./mileageBonus/bonusRun.js           a run, plus the admin actions
 *
 * REAL MONEY. Two independent guards stop a milestone being announced twice: the
 * UNIQUE (driver_normalized_name, threshold_miles) row per notification and the
 * leased `mileage_bonus_runs` key per run. The tick keeps the run key at the
 * MOST RECENT scheduled occurrence, which is what makes the catch-up
 * sleep-safe — an instance down at 07:00 still runs once when it returns.
 */
const { DateTime } = require('luxon');
const { createDueTimeWakeTimer } = require('./dueTimeWakeTimer');
const datatruck = require('./datatruckApiService');
const {
  SCHEDULE_TIMEZONE, mostRecentScheduledRun, nextScheduledRun,
} = require('./mileageBonusConstants');
const { isRunning, isRunActive } = require('./mileageBonus/runState');
const { computeDriverMileage } = require('./mileageBonus/mileageComputation');
const {
  removeTelegramCard, resendBonusNotification, disregardBonusNotification,
} = require('./mileageBonus/notificationCards');
const {
  runMileageBonusCheck, refreshProgressOnly, setDriverActivation, getOverview,
} = require('./mileageBonus/bonusRun');

let serviceTimer = null;

let serviceStopped = false;

let tickRunning = false;

// ─── Weekly scheduler (Wednesday 07:00 Central, sleep-safe catch-up) ───

// One pass, resolving { dueAtMs } so the wake chain sleeps until the next Wed
// 07:00 instead of leasing a run key every minute for a weekly job. The run key
// stays the MOST RECENT occurrence, preserving the sleep-safe catch-up.
async function tick() {
  if (tickRunning || activeRun) return { retry: false };
  tickRunning = true;
  const now = DateTime.now().setZone(SCHEDULE_TIMEZONE);
  const dueAtMs = nextScheduledRun(now).toMillis();
  try {
    if (!datatruck.isConfigured()) return { retry: false, dueAtMs };
    const scheduledRun = mostRecentScheduledRun(now);
    const runKey = `weekly:${scheduledRun.toISODate()}`;
    const result = await runMileageBonusCheck({
      trigger: 'scheduled', referenceDate: scheduledRun, runKey,
    });
    if (!result?.skipped && !result?.busy) {
      console.log(`[MILEAGE-BONUS] Weekly run completed for ${runKey}`);
    }
    return { retry: false, dueAtMs };
  } catch (err) {
    console.error('[MILEAGE-BONUS] Scheduler tick error:', err.message);
    return { retry: true };
  } finally {
    tickRunning = false;
  }
}

function startMileageBonusService() {
  serviceStopped = false;
  console.log(
    `[MILEAGE-BONUS] Service started — weekly check Wednesday 07:00 ${SCHEDULE_TIMEZONE}`
    + (datatruck.isConfigured() ? '' : ' (Datatruck API not configured yet — idle)')
  );
  // Defer the first tick briefly so the bot/telegram is fully ready, then sleep
  // until the next scheduled run rather than polling every minute.
  serviceTimer = createDueTimeWakeTimer({ label: 'MILEAGE-BONUS', runTick: tick });
  serviceTimer.start(10 * 1000);
}

function stopMileageBonusService() {
  serviceStopped = true;
  if (serviceTimer) {
    serviceTimer.stop();
    serviceTimer = null;
  }
}

module.exports = {
  startMileageBonusService,
  stopMileageBonusService,
  runMileageBonusCheck,
  refreshProgressOnly,
  getOverview,
  computeDriverMileage,
  isRunning,
  isRunActive,
  tick,
  resendBonusNotification,
  disregardBonusNotification,
  setDriverActivation,
  removeTelegramCard,
};
