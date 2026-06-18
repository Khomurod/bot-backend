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
 * - Survives Render free-tier sleeps via a service_runs weekly claim, so a
 *   missed Wednesday is caught up the next time the instance wakes.
 */
const { DateTime } = require('luxon');
const db = require('../database/db');
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

const SERVICE_NAME = 'mileage_bonus';
const POLL_MS = 60 * 1000;

let serviceTimer = null;
let serviceStopped = false;
let tickRunning = false;
let activeRun = null; // Promise lock so manual + scheduled runs never overlap.
let lastRunSummary = null;

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
async function computeDriverMileage(referenceDate) {
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
 * unique constraint guarantees single-notification); if the send fails, the
 * claim is rolled back so a later run can retry.
 */
async function sendBonusNotification(driver, tier, { trigger, periodEndDate }) {
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
    // Roll back the claim so the milestone can be retried next run.
    await mb.deleteBonusNotification(claimed.id).catch(() => {});
    throw err;
  }
}

/**
 * Run the full check: recompute mileage, persist progress, and send any
 * newly-qualified milestone cards.
 * @param {object} [opts]
 * @param {string} [opts.trigger='scheduled']
 * @param {DateTime} [opts.referenceDate]  Central datetime; defaults to now.
 */
async function runMileageBonusCheck({ trigger = 'scheduled', referenceDate } = {}) {
  if (activeRun) {
    return activeRun.then(() => ({ busy: true }), () => ({ busy: true }));
  }
  const run = (async () => {
    if (!datatruck.isConfigured()) {
      return { configured: false, reason: 'datatruck_not_configured' };
    }
    const ref = (referenceDate || DateTime.now()).setZone(SCHEDULE_TIMEZONE);
    const { periodEnd, periodEndDate, drivers } = await computeDriverMileage(ref);
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
    return summary;
  })();

  activeRun = run;
  try {
    return await run;
  } finally {
    activeRun = null;
  }
}

/**
 * Recompute and persist progress WITHOUT sending notifications (preview).
 */
async function refreshProgressOnly({ referenceDate } = {}) {
  if (!datatruck.isConfigured()) {
    return { configured: false, reason: 'datatruck_not_configured' };
  }
  const ref = (referenceDate || DateTime.now()).setZone(SCHEDULE_TIMEZONE);
  const { periodEndDate, drivers } = await computeDriverMileage(ref);
  await persistProgress(drivers);
  return {
    configured: true,
    companyDrivers: drivers.length,
    periodStart: PROGRAM_START_ISO,
    periodEnd: periodEndDate,
    ranAt: DateTime.now().toISO(),
  };
}

/** Admin overview payload (reads cached DB snapshot — fast, no API calls). */
async function getOverview() {
  const [progress, notifications] = await Promise.all([
    mb.listDriverProgress(),
    mb.listBonusNotifications({ limit: 300 }),
  ]);
  return {
    configured: datatruck.isConfigured(),
    running: Boolean(activeRun),
    lastRun: lastRunSummary,
    tiers: MILEAGE_BONUS_TIERS,
    programStart: PROGRAM_START_ISO,
    progress,
    notifications,
  };
}

function isRunning() {
  return Boolean(activeRun);
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
    const claimed = await db.claimServiceRun(SERVICE_NAME, runKey);
    if (!claimed) return;
    console.log(`[MILEAGE-BONUS] Weekly run claimed for ${runKey}`);
    await runMileageBonusCheck({ trigger: 'scheduled', referenceDate: scheduledRun });
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
  tick,
};
