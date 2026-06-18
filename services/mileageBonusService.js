/**
 * Mileage Bonus service.
 *
 * - Pulls COMPANY DRIVERS and their cumulative driven miles from the Datatruck
 *   OpenAPI (counting from each driver's start date, floored at the program
 *   start of 2026-04-17, through the current pay period end — the Sunday two
 *   weeks behind).
 * - Awards a one-time bonus card to the "Bonus Penalty For Drivers" group each
 *   time a driver crosses a milestone, with Paid / Rejected inline buttons.
 * - Runs automatically every Wednesday 07:00 Central, and on demand from the
 *   admin panel. Idempotent: a (driver, milestone) is notified at most once.
 * - Survives sleeps and failed attempts through a durable, leased run ledger;
 *   a missed or failed Wednesday run is caught up and retried with backoff.
 */
const { DateTime } = require('luxon');
const { randomUUID } = require('node:crypto');
const mb = require('../database/mileageBonus');
const { bot } = require('../bot/bot');
const { safeSend } = require('./telegramHtml');
const datatruck = require('./datatruckApiService');
const { buildBonusCardText } = require('./mileageBonusMessages');
const {
  BONUS_GROUP_CHAT_ID,
  PROGRAM_START_ISO,
  SCHEDULE_TIMEZONE,
  INCLUDE_EMPTY_MILES,
  CREDIT_TEAM_CO_DRIVER,
  MILEAGE_BONUS_TIERS,
  normalizeDriverName,
  toMiles,
  computePayPeriodEnd,
  mostRecentScheduledRun,
  driverPeriodStart,
  tiersReached,
  nextTier,
} = require('./mileageBonusConstants');

const POLL_MS = 60 * 1000;

let serviceTimer = null;
let serviceStopped = false;
let tickRunning = false;
let activeRun = null; // Promise lock so manual + scheduled runs never overlap.
let lastRunSummary = null;

function serviceError(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function makeRunKey(trigger, mode) {
  return `${trigger}:${mode}:${DateTime.now().toUTC().toFormat('yyyyLLdd-HHmmss')}:${randomUUID()}`;
}

function retryDelayMinutes(attemptCount) {
  return Math.min(60, 5 * (2 ** Math.max(0, Number(attemptCount || 1) - 1)));
}

function getOrderPickupIso(order) {
  return order.pickup_time
    || order.pickup_appointment_time
    || order.delivery_time
    || order.created_datetime
    || null;
}

function tripMiles(order) {
  const trip = order.trip || {};
  const loaded = toMiles(trip.mile ?? order.total_miles);
  const empty = INCLUDE_EMPTY_MILES ? toMiles(trip.empty_mile) : 0;
  return loaded + empty;
}

/**
 * Fetch + aggregate cumulative miles per active company driver.
 * @param {DateTime} referenceDate  Central datetime anchoring the pay period.
 * @returns {{ periodEnd: DateTime, drivers: Array }}
 */
async function computeDriverMileage(referenceDate, { inactiveKeys = new Set() } = {}) {
  const periodEnd = computePayPeriodEnd(referenceDate);
  const programStart = DateTime.fromISO(PROGRAM_START_ISO, { zone: SCHEDULE_TIMEZONE }).startOf('day');
  const startIso = programStart.toUTC().toISO();
  const endIso = periodEnd.toUTC().toISO();

  const driverRows = await datatruck.fetchAllDrivers();
  const companyByName = new Map();
  for (const d of driverRows) {
    if (d.driver_type !== 'company_driver') continue;
    const fullName = d.account?.full_name
      || [d.account?.first_name, d.account?.last_name].filter(Boolean).join(' ');
    const normalized = normalizeDriverName(fullName);
    if (!normalized) continue;
    if (inactiveKeys.has(normalized)) continue;
    const startDt = driverPeriodStart(d.hire_date);
    companyByName.set(normalized, {
      externalId: d.id != null ? String(d.id) : null,
      name: fullName,
      normalizedName: normalized,
      hireDate: d.hire_date || null,
      periodStartDt: startDt,
      periodStartMs: startDt.toMillis(),
      periodStartIso: startDt.toISODate(),
      totalMiles: 0,
      trips: 0,
    });
  }

  const orders = await datatruck.fetchOrdersByPickupWindow(startIso, endIso);
  for (const order of orders) {
    const pickupIso = getOrderPickupIso(order);
    if (!pickupIso) continue;
    const pickupMs = DateTime.fromISO(pickupIso, { zone: 'utc' }).toMillis();
    if (!Number.isFinite(pickupMs)) continue;
    const miles = tripMiles(order);
    if (miles <= 0) continue;

    const trip = order.trip || {};
    const candidates = [trip.driver__full_name];
    if (CREDIT_TEAM_CO_DRIVER && trip.team_driver__full_name) {
      candidates.push(trip.team_driver__full_name);
    }
    for (const candidate of candidates) {
      const driver = companyByName.get(normalizeDriverName(candidate));
      if (!driver) continue;
      if (pickupMs < driver.periodStartMs) continue; // before this driver started counting
      driver.totalMiles += miles;
      driver.trips += 1;
    }
  }

  const periodEndDate = periodEnd.toISODate();
  const drivers = [...companyByName.values()].map((d) => {
    const reached = tiersReached(d.totalMiles);
    const highest = reached.length ? reached[reached.length - 1].miles : null;
    const next = nextTier(d.totalMiles);
    return {
      ...d,
      totalMiles: Math.round(d.totalMiles * 100) / 100,
      periodEndIso: periodEndDate,
      tiersReached: reached,
      highestTier: highest,
      nextTier: next ? next.miles : null,
      milesToNextTier: next ? Math.round((next.miles - d.totalMiles) * 100) / 100 : null,
    };
  }).sort((a, b) => b.totalMiles - a.totalMiles);

  return { periodEnd, periodEndDate, drivers };
}

async function persistProgress(drivers) {
  for (const d of drivers) {
    await mb.upsertDriverProgress({
      driver_external_id: d.externalId,
      driver_normalized_name: d.normalizedName,
      driver_name: d.name,
      driver_type: 'company_driver',
      hire_date: d.hireDate,
      period_start: d.periodStartIso,
      period_end: d.periodEndIso,
      total_miles: d.totalMiles,
      trips: d.trips,
      highest_tier_reached: d.highestTier,
      next_tier: d.nextTier,
      miles_to_next_tier: d.milesToNextTier,
    });
  }
}

function buildKeyboard(notificationId) {
  return {
    inline_keyboard: [[
      { text: '✅ Paid', callback_data: `mbonus:paid:${notificationId}` },
      { text: '❌ Rejected in Pay', callback_data: `mbonus:rej:${notificationId}` },
    ]],
  };
}

/**
 * Send one milestone bonus card. Claims the (driver, tier) row first (the
 * unique constraint guarantees a single business record). Failed delivery is
 * retained and made retryable without deleting the audit record.
 */
async function sendBonusNotification(driver, tier, { trigger, periodEndDate }) {
  if (!(await mb.isDriverActive(driver.normalizedName))) {
    return { skipped: true, reason: 'driver_inactive' };
  }
  const claimed = await mb.claimBonusNotification({
    driver_external_id: driver.externalId,
    driver_normalized_name: driver.normalizedName,
    driver_name: driver.name,
    threshold_miles: tier.miles,
    bonus_amount: tier.amount,
    miles_at_notification: driver.totalMiles,
    period_start: driver.periodStartIso,
    period_end: periodEndDate,
    trigger,
  });
  if (!claimed) return { skipped: true };

  const text = buildBonusCardText({
    driver_name: driver.name,
    threshold_miles: tier.miles,
    bonus_amount: tier.amount,
    miles_at_notification: driver.totalMiles,
    period_start: driver.periodStartIso,
    period_end: periodEndDate,
  });

  try {
    const sent = await safeSend(() => bot.telegram.sendMessage(BONUS_GROUP_CHAT_ID, text, {
      parse_mode: 'HTML',
      reply_markup: buildKeyboard(claimed.id),
    }));
    await mb.setBonusNotificationMessage(claimed.id, BONUS_GROUP_CHAT_ID, sent?.message_id || null);
    return { sent: true, id: claimed.id };
  } catch (err) {
    // Preserve the business-key claim. A later run can reclaim a known failed
    // delivery without creating a second notification row.
    await mb.markBonusNotificationDeliveryFailed(claimed.id, err.message).catch(() => {});
    throw err;
  }
}

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

    for (const driver of drivers) {
      if (!driver.tiersReached.length) continue;
      qualifyingDrivers += 1;
      for (const tier of driver.tiersReached) {
        try {
          const result = await sendBonusNotification(driver, tier, { trigger, periodEndDate });
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
      errors,
      ranAt: DateTime.now().toISO(),
    };
    lastRunSummary = summary;
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

async function removeTelegramCard(record) {
  if (record?.telegram_deleted_at) {
    return { deleted: true, missing: true, buttonsRemoved: false, error: null };
  }
  if (!record?.telegram_chat_id
      || (!record?.telegram_message_id && !record?.telegram_followup_message_id)) {
    return { deleted: true, missing: true, buttonsRemoved: false, error: null };
  }
  const messageIds = [record.telegram_message_id, record.telegram_followup_message_id].filter(Boolean);
  const errors = [];
  let buttonsRemoved = false;
  let deletedCount = 0;
  for (const messageId of messageIds) {
    try {
      await bot.telegram.deleteMessage(record.telegram_chat_id, messageId);
      deletedCount += 1;
    } catch (deleteErr) {
      if (String(messageId) === String(record.telegram_message_id)) {
        try {
          await bot.telegram.editMessageReplyMarkup(
            record.telegram_chat_id,
            messageId,
            undefined,
            { inline_keyboard: [] }
          );
          buttonsRemoved = true;
          errors.push(`Telegram could not delete message ${messageId}: ${deleteErr.message}`);
          continue;
        } catch (editErr) {
          errors.push(
            `Telegram delete failed for ${messageId}: ${deleteErr.message}; `
            + `button removal failed: ${editErr.message}`
          );
          continue;
        }
      }
      errors.push(`Telegram could not delete follow-up ${messageId}: ${deleteErr.message}`);
    }
  }
  return {
    deleted: deletedCount === messageIds.length,
    missing: false,
    buttonsRemoved,
    error: errors.length ? errors.join(' | ') : null,
  };
}

async function resendBonusNotification(notificationId, { username } = {}) {
  const existing = await mb.getBonusNotificationById(notificationId);
  if (!existing) throw serviceError('NOT_FOUND', 'Bonus notification not found.', 404);
  if (existing.status === 'paid') {
    throw serviceError('ALREADY_PAID', 'Paid bonuses cannot be resent.', 409);
  }
  if (!(await mb.isDriverActive(existing.driver_normalized_name))) {
    throw serviceError('DRIVER_INACTIVE', 'Activate this driver before resending a bonus.', 409);
  }

  const claimed = await mb.claimNotificationAction(notificationId, 'resending');
  if (!claimed) throw serviceError('ACTION_BUSY', 'This notification is already being updated.', 409);

  let sent = null;
  try {
    const text = buildBonusCardText(claimed);
    sent = await safeSend(() => bot.telegram.sendMessage(BONUS_GROUP_CHAT_ID, text, {
      parse_mode: 'HTML',
      reply_markup: buildKeyboard(claimed.id),
    }));
    const updated = await mb.finalizeNotificationResend(claimed.id, {
      chatId: BONUS_GROUP_CHAT_ID,
      messageId: sent.message_id,
      username,
    });
    if (!updated) throw new Error('Could not finalize the resent notification.');

    const cleanup = await removeTelegramCard(claimed);
    if (cleanup.error) {
      await mb.releaseNotificationAction(claimed.id, cleanup.error).catch(() => {});
    }
    return { notification: updated, cleanup };
  } catch (err) {
    if (sent?.message_id) {
      await bot.telegram.deleteMessage(BONUS_GROUP_CHAT_ID, sent.message_id).catch(() => {});
    }
    await mb.releaseNotificationAction(claimed.id, err.message).catch(() => {});
    throw err;
  }
}

async function disregardBonusNotification(notificationId, { username } = {}) {
  const existing = await mb.getBonusNotificationById(notificationId);
  if (!existing) throw serviceError('NOT_FOUND', 'Bonus notification not found.', 404);
  if (existing.status === 'paid') {
    throw serviceError('ALREADY_PAID', 'Paid bonuses cannot be disregarded.', 409);
  }
  if (existing.status === 'disregarded') {
    return { notification: existing, cleanup: { deleted: Boolean(existing.telegram_deleted_at) } };
  }

  const claimed = await mb.claimNotificationAction(notificationId, 'disregarding');
  if (!claimed) throw serviceError('ACTION_BUSY', 'This notification is already being updated.', 409);
  const disregarded = await mb.markNotificationDisregarded(notificationId, username);
  if (!disregarded) {
    await mb.releaseNotificationAction(notificationId, 'Could not mark notification disregarded.');
    throw new Error('Could not mark notification disregarded.');
  }

  const cleanup = await removeTelegramCard(disregarded);
  const updated = await mb.completeNotificationCleanup(notificationId, cleanup);
  return { notification: updated || disregarded, cleanup };
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
    lastRun: persistedSummary || lastRunSummary,
    lastRunRecord: latestRun,
    tiers: MILEAGE_BONUS_TIERS,
    programStart: PROGRAM_START_ISO,
    progress,
    notifications,
  };
}

function isRunning() {
  return Boolean(activeRun);
}

async function isRunActive() {
  return Boolean(activeRun) || mb.isMileageBonusRunActive();
}

// ─── Weekly scheduler (Wednesday 07:00 Central, sleep-safe catch-up) ───

async function tick() {
  if (tickRunning || activeRun) return;
  tickRunning = true;
  try {
    if (!datatruck.isConfigured()) return;
    const now = DateTime.now().setZone(SCHEDULE_TIMEZONE);
    const scheduledRun = mostRecentScheduledRun(now);
    const runKey = `weekly:${scheduledRun.toISODate()}`;
    const result = await runMileageBonusCheck({
      trigger: 'scheduled', referenceDate: scheduledRun, runKey,
    });
    if (!result?.skipped && !result?.busy) {
      console.log(`[MILEAGE-BONUS] Weekly run completed for ${runKey}`);
    }
  } catch (err) {
    console.error('[MILEAGE-BONUS] Scheduler tick error:', err.message);
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
  // Defer the first tick briefly so the bot/telegram is fully ready.
  setTimeout(() => { if (!serviceStopped) tick(); }, 10 * 1000).unref?.();
  serviceTimer = setInterval(() => { if (!serviceStopped) tick(); }, POLL_MS);
  serviceTimer.unref?.();
}

function stopMileageBonusService() {
  serviceStopped = true;
  if (serviceTimer) {
    clearInterval(serviceTimer);
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
