/**
 * Road Bonus Notifier service.
 *
 * Posts the extra-week bonus to the "Bonus Penalty For Drivers" group WHILE the
 * driver is still on the road — not when they get home. The moment a company
 * driver completes a FULL extra week beyond the road allowance (e.g. finishes
 * their 5th week when the allowance is 4), we post a message saying they need a
 * $100 bonus for that additional week. Every subsequent full extra week (6th,
 * 7th, …) is posted too, for as long as they stay out.
 *
 * Idempotent + catch-up: each driver group carries a per-leg watermark
 * (driver_home_status.road_bonus_weeks_notified) of how many extra-week
 * milestones have already been posted. On each pass we compute how many full
 * extra weeks have elapsed as of now and post exactly the ones above the
 * watermark — so a delayed/missed check catches up all the missed weeks in one
 * pass, and a repeated check posts nothing. The watermark resets to 0 whenever a
 * new road leg starts (see homeTimeService.js).
 *
 * Scope: company_driver only (never owner-operators) and only while
 * home_time_settings.enabled. Modelled on the other setInterval pollers
 * (mileageBonusService, etc.): a tickRunning guard prevents overlapping ticks
 * and bot.telegram is passed in to avoid a require cycle with bot/bot.js.
 */
const { DateTime } = require('luxon');
const ht = require('../database/homeTime');
const { safeSend } = require('./telegramHtml');
const { BONUS_GROUP_CHAT_ID } = require('./mileageBonusConstants');
const {
  computeRoadBonus, homeTimePolicyApplies, DEFAULT_BONUS_PER_WEEK,
} = require('./homeTimeConstants');
const { inferDriverType } = require('./driverProfileParse');

// Check hourly. Extra-week milestones only tick once every seven days per
// driver, so there is no value in polling tightly; hourly keeps the catch-up
// latency small after a sleep without any load.
const POLL_MS = 60 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 15 * 1000;

let serviceTimer = null;
let serviceStopped = false;
let tickRunning = false;
let telegramClient = null;

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function driverLabelFromRow(row) {
  const name = [row?.first_name, row?.last_name].filter(Boolean).join(' ').trim();
  return name || row?.group_name || `Group ${row?.group_id}`;
}

function driverTypeFromRow(row) {
  return row?.driver_type || inferDriverType(row?.group_name || '');
}

/**
 * Build the "needs a $X bonus for the additional week" message for one
 * newly-completed extra week.
 *
 * @param {number} extraWeekIndex  1 for the first extra week, 2 for the second…
 * @param {number} allowanceWeeks  the free road allowance in weeks
 * @param {number} bonusPerWeek    dollars per extra week
 */
function buildExtraWeekMessage({
  driverName, unitNumber, extraWeekIndex, allowanceWeeks, bonusPerWeek,
}) {
  const who = `${escapeHtml(driverName)}${unitNumber ? ` (Unit ${escapeHtml(unitNumber)})` : ''}`;
  const weekOnRoad = Number(allowanceWeeks) + Number(extraWeekIndex);
  const bonus = Number(bonusPerWeek) || 0;
  return `🚚 <b>${who}</b> has completed <b>week ${weekOnRoad}</b> on the road — `
    + `1 full week beyond the ${allowanceWeeks}-week allowance `
    + `(extra week #${extraWeekIndex}).\n`
    + `Needs a <b>$${bonus.toFixed(0)} bonus</b> for the additional week on the road.`;
}

/**
 * One driver group: post any extra-week milestones that have completed since the
 * watermark, then advance the watermark. Never throws.
 *
 * @returns {{ posted:number, exceededWeeks:number }|null}
 */
async function processRoadDriver(telegram, row, settings, now) {
  const driverType = driverTypeFromRow(row);
  if (!homeTimePolicyApplies(driverType)) return null; // owner-operators excluded

  const allowanceWeeks = Number(settings.road_allowance_weeks);
  const bonusPerWeek = settings.bonus_per_week == null
    ? DEFAULT_BONUS_PER_WEEK
    : Number(settings.bonus_per_week);

  const { exceededWeeks } = computeRoadBonus(row.state_since, now, {
    roadAllowanceWeeks: allowanceWeeks,
    bonusPerWeek,
    driverType,
  });

  const alreadyNotified = Math.max(0, Number(row.road_bonus_weeks_notified) || 0);
  if (exceededWeeks <= alreadyNotified) return { posted: 0, exceededWeeks };

  const driverName = driverLabelFromRow(row);
  const unitNumber = row.unit_number || null;

  let posted = 0;
  for (let week = alreadyNotified + 1; week <= exceededWeeks; week += 1) {
    const text = buildExtraWeekMessage({
      driverName, unitNumber, extraWeekIndex: week, allowanceWeeks, bonusPerWeek,
    });
    // eslint-disable-next-line no-await-in-loop
    await safeSend(() => telegram.sendMessage(BONUS_GROUP_CHAT_ID, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }));
    posted += 1;
  }

  // Advance the watermark only after the posts succeeded. If a send threw, we
  // stop before updating so the un-posted weeks are retried next pass.
  await ht.setRoadBonusWeeksNotified(row.group_id, exceededWeeks);
  console.log(
    `[ROAD-BONUS] ${driverName} on road ${exceededWeeks} extra week(s); posted ${posted} new`
  );
  return { posted, exceededWeeks };
}

/**
 * One full pass over every on-road driver. Pure-ish: pass `telegram` and an
 * optional `now` (DateTime|ISO) so it can be unit-tested deterministically.
 *
 * @returns {{ enabled:boolean, drivers:number, notificationsSent:number, errors:number }}
 */
async function runRoadBonusCheck(telegram, { now } = {}) {
  const settings = await ht.getHomeTimeSettings();
  if (!settings || !settings.enabled) {
    return { enabled: false, drivers: 0, notificationsSent: 0, errors: 0 };
  }
  const asOf = now || DateTime.now().toUTC().toISO();

  const rows = await ht.listOnRoadStatuses();
  let notificationsSent = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await processRoadDriver(telegram, row, settings, asOf);
      if (result) notificationsSent += result.posted;
    } catch (err) {
      errors += 1;
      console.error(`[ROAD-BONUS] Failed for group ${row.group_id}:`, err.message);
    }
  }
  return {
    enabled: true, drivers: rows.length, notificationsSent, errors,
  };
}

async function tick() {
  if (tickRunning || !telegramClient) return;
  tickRunning = true;
  try {
    await runRoadBonusCheck(telegramClient);
  } catch (err) {
    console.error('[ROAD-BONUS] Scheduler tick error:', err.message);
  } finally {
    tickRunning = false;
  }
}

function startRoadBonusNotifierService(telegram) {
  if (telegram) telegramClient = telegram;
  serviceStopped = false;
  console.log(`[ROAD-BONUS] Service started — checking on-road drivers every ${POLL_MS / 60000}min`);
  setTimeout(() => { if (!serviceStopped) tick(); }, FIRST_TICK_DELAY_MS).unref?.();
  serviceTimer = setInterval(() => { if (!serviceStopped) tick(); }, POLL_MS);
  serviceTimer.unref?.();
}

function stopRoadBonusNotifierService() {
  serviceStopped = true;
  if (serviceTimer) {
    clearInterval(serviceTimer);
    serviceTimer = null;
  }
}

module.exports = {
  startRoadBonusNotifierService,
  stopRoadBonusNotifierService,
  runRoadBonusCheck,
  processRoadDriver,
  buildExtraWeekMessage,
  tick,
};
