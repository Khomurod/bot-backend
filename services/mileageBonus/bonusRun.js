/**
 * Mileage-bonus RUNS and the admin actions around them.
 *
 * A run computes progress, persists it, and sends a card for every newly
 * qualifying milestone; `refreshProgressOnly` does the same without sending.
 * Both go through runTracked() so the lease and the in-process lock apply.
 *
 * With no configured destination group the run still PERSISTS progress and sends
 * nothing, rather than falling back to a hardcoded chat — a still-owed milestone
 * is then sent by a later run once configured.
 *
 * Split out of services/mileageBonusService.js, which re-exports these.
 */
const { DateTime } = require('luxon');
const mb = require('../../database/mileageBonus');
const messageGroups = require('../../database/messageRoutingSettings');
const datatruck = require('../datatruckApiService');
const { serviceError } = require('./runHelpers');
const {
  PROGRAM_START_ISO, SCHEDULE_TIMEZONE, MILEAGE_BONUS_TIERS, normalizeDriverName,
} = require('../mileageBonusConstants');
const {
  runTracked, isRunning, getLastRunSummary, setLastRunSummary,
} = require('./runState');
const { computeDriverMileage, persistProgress } = require('./mileageComputation');
const {
  sendBonusNotification, disregardBonusNotification,
} = require('./notificationCards');

/**
 * Run the full check: recompute mileage, persist progress, and send any
 * newly-qualified milestone cards.
 * @param {object} [opts]
 * @param {string} [opts.trigger='scheduled']
 * @param {DateTime} [opts.referenceDate]  Central datetime; defaults to now.
 */
async function runMileageBonusCheck({
  trigger = 'scheduled', referenceDate, runKey, requestedBy,
} = {}) {
  return runTracked({ trigger, mode: 'notify', runKey, requestedBy }, async () => {
    if (!datatruck.isConfigured()) {
      return { configured: false, reason: 'datatruck_not_configured' };
    }
    const ref = (referenceDate || DateTime.now()).setZone(SCHEDULE_TIMEZONE);
    const inactiveKeys = await mb.listInactiveDriverKeys();
    const { periodEndDate, drivers } = await computeDriverMileage(ref, { inactiveKeys });
    await persistProgress(drivers);

    const notificationsSent = [];
    const errors = [];
    let qualifyingDrivers = 0;

    // The destination is admin-configured (Settings → Telegram Groups). With no
    // configured group we do NOT fall back to any old hardcoded default — we
    // skip the send entirely and surface a clear configuration error. Progress
    // is still persisted above, and no notification rows are claimed, so a later
    // run (once configured) sends the still-owed milestone cards.
    const chatId = await messageGroups.getGroupId('mileageBonus');
    if (!chatId) {
      const configError = messageGroups.missingGroupMessage('mileageBonus');
      const qualifying = drivers.filter((d) => d.tiersReached.length).length;
      console.error(`[MILEAGE-BONUS] ${configError} Not sending ${qualifying} qualifying driver notification(s).`);
      const summary = {
        configured: true,
        mode: 'notify',
        trigger,
        periodStart: PROGRAM_START_ISO,
        periodEnd: periodEndDate,
        companyDrivers: drivers.length,
        qualifyingDrivers: qualifying,
        notificationsSent: [],
        notificationsSentCount: 0,
        groupConfigured: false,
        configError,
        errors: [],
        ranAt: DateTime.now().toISO(),
      };
      setLastRunSummary(summary);
      return summary;
    }

    for (const driver of drivers) {
      if (!driver.tiersReached.length) continue;
      qualifyingDrivers += 1;
      for (const tier of driver.tiersReached) {
        try {
          const result = await sendBonusNotification(driver, tier, { trigger, periodEndDate, chatId });
          if (result.sent) {
            notificationsSent.push({ driver: driver.name, miles: tier.miles, amount: tier.amount });
          }
        } catch (err) {
          console.error(
            `[MILEAGE-BONUS] Failed to send ${driver.name} ${tier.miles}mi:`,
            err.message
          );
          errors.push({ driver: driver.name, miles: tier.miles, error: err.message });
        }
      }
    }

    const summary = {
      configured: true,
      mode: 'notify',
      trigger,
      periodStart: PROGRAM_START_ISO,
      periodEnd: periodEndDate,
      companyDrivers: drivers.length,
      qualifyingDrivers,
      notificationsSent,
      notificationsSentCount: notificationsSent.length,
      groupConfigured: true,
      errors,
      ranAt: DateTime.now().toISO(),
    };
    setLastRunSummary(summary);
    console.log(
      `[MILEAGE-BONUS] Run (${trigger}) complete: ${drivers.length} company drivers, `
      + `${notificationsSent.length} new notifications, ${errors.length} errors, `
      + `period ${PROGRAM_START_ISO}→${periodEndDate}`
    );
    if (errors.length) {
      const err = new Error(`${errors.length} mileage bonus notification(s) failed; retry scheduled.`);
      err.summary = summary;
      throw err;
    }
    return summary;
  });
}

/**
 * Recompute and persist progress WITHOUT sending notifications (preview).
 */
async function refreshProgressOnly({ referenceDate, requestedBy } = {}) {
  return runTracked({
    trigger: 'manual', mode: 'refresh', requestedBy,
  }, async () => {
    if (!datatruck.isConfigured()) {
      return { configured: false, reason: 'datatruck_not_configured' };
    }
    const ref = (referenceDate || DateTime.now()).setZone(SCHEDULE_TIMEZONE);
    const inactiveKeys = await mb.listInactiveDriverKeys();
    const { periodEndDate, drivers } = await computeDriverMileage(ref, { inactiveKeys });
    await persistProgress(drivers);
    return {
      configured: true,
      mode: 'refresh',
      trigger: 'manual',
      companyDrivers: drivers.length,
      periodStart: PROGRAM_START_ISO,
      periodEnd: periodEndDate,
      notificationsSentCount: 0,
      errors: [],
      ranAt: DateTime.now().toISO(),
    };
  });
}

async function setDriverActivation(normalizedName, isActive, { username } = {}) {
  const progress = await mb.setDriverActive(normalizedName, isActive, username);
  if (!progress) throw serviceError('NOT_FOUND', 'Driver progress record not found.', 404);

  const cleanedNotifications = [];
  if (!isActive) {
    const open = await mb.listOpenNotificationsForDriver(normalizedName);
    for (const notification of open) {
      try {
        cleanedNotifications.push(await disregardBonusNotification(notification.id, { username }));
      } catch (err) {
        cleanedNotifications.push({ notificationId: notification.id, error: err.message });
      }
    }
  }
  return { progress, cleanedNotifications };
}

/** Admin overview payload (reads cached DB snapshot — fast, no API calls). */
async function getOverview() {
  const [progress, notifications, latestRun, dbRunning] = await Promise.all([
    mb.listDriverProgress(),
    mb.listBonusNotifications({ limit: 1000 }),
    mb.getLatestMileageBonusRun(),
    mb.isMileageBonusRunActive(),
  ]);
  const persistedSummary = latestRun?.summary || null;
  return {
    configured: datatruck.isConfigured(),
    running: Boolean(activeRun) || dbRunning,
    lastRun: persistedSummary || getLastRunSummary(),
    lastRunRecord: latestRun,
    tiers: MILEAGE_BONUS_TIERS,
    programStart: PROGRAM_START_ISO,
    progress,
    notifications,
  };
}

module.exports = {
  runMileageBonusCheck,
  refreshProgressOnly,
  setDriverActivation,
  getOverview,
};
