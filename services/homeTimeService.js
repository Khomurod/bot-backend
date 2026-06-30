/**
 * Driver Home-Time Tracking service.
 *
 * Event-driven half: the bot's group-message handler calls
 * handleDriverGroupStatus() for every message in a driver group. We look for
 * "Status: Home / Ready / Rolling", keep a simple home/road state machine per
 * driver group, and — when a driver comes home after more than the allowed
 * weeks on the road — record the trip and post a recognition note to the
 * employee group.
 *
 * Scheduled half: startHomeTimeBonusScheduler() polls every driver still on
 * the road and posts a "Bonus Penalty For Drivers" group notification for
 * each newly-completed full extra week (e.g. the 5th week on a 4-week
 * allowance) — in real time, while the driver is still out, rather than
 * waiting for them to get home.
 */
const { DateTime } = require('luxon');
const db = require('../database/db');
const ht = require('../database/homeTime');
const config = require('../config/config');
const { safeSend } = require('./telegramHtml');
const { BONUS_GROUP_CHAT_ID } = require('./mileageBonusConstants');
const {
  parseDriverStatus, computeRoadBonus, homeTimePolicyApplies, newlyCrossedExtraWeeks,
} = require('./homeTimeConstants');
const { inferDriverType } = require('./driverProfileParse');

const BONUS_CHECK_POLL_MS = 30 * 60 * 1000; // 30 minutes — week-granularity doesn't need finer polling.

let schedulerTelegram = null;
let schedulerTimer = null;
let schedulerStopped = false;
let schedulerTickRunning = false;

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Timestamp the status message was sent (Telegram seconds → ISO), or now. */
function messageTimestampIso(message) {
  const secs = Number(message?.date);
  if (Number.isFinite(secs) && secs > 0) {
    return DateTime.fromSeconds(secs).toUTC().toISO();
  }
  return DateTime.now().toUTC().toISO();
}

/** Best display name + unit for a driver group (falls back to the group name). */
async function resolveDriverLabel(group) {
  try {
    const profile = await db.getDriverProfileByGroupId(group.id);
    const name = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ').trim();
    return {
      driverName: name || group.group_name || `Group ${group.id}`,
      unitNumber: profile?.unit_number || null,
      driverType: profile?.driver_type || inferDriverType(group.group_name || ''),
    };
  } catch (err) {
    return {
      driverName: group.group_name || `Group ${group.id}`,
      unitNumber: null,
      driverType: inferDriverType(group.group_name || ''),
    };
  }
}

/**
 * Posted to the Bonus Penalty group the moment a driver still on the road
 * completes a new full extra week beyond the allowance — e.g. the 5th week on
 * a 4-week allowance. One message per newly-crossed week, $bonusPerWeek each.
 */
async function postExtraWeekBonusToGroup(telegram, {
  driverName, unitNumber, absoluteWeek, allowanceWeeks, bonusUsd,
}) {
  const who = `${escapeHtml(driverName)}${unitNumber ? ` (Unit ${escapeHtml(unitNumber)})` : ''}`;
  const text = `⏱️ <b>${who}</b> just completed week <b>${absoluteWeek}</b> on the road (limit is ${allowanceWeeks} week${allowanceWeeks === 1 ? '' : 's'}).\n`
    + `Add a <b>$${Number(bonusUsd).toFixed(0)} bonus</b> for the additional week on the road.`;
  await safeSend(() => telegram.sendMessage(BONUS_GROUP_CHAT_ID, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }));
}

/**
 * Posted to the employee group when a driver who went over the allowance
 * finally gets home — a recognition note, not a bonus/accounting message
 * (those already went to the Bonus Penalty group while the driver was out).
 */
async function postRecognitionToEmployeeGroup(telegram, {
  driverName, unitNumber, daysOnRoad, totalWeeks,
}) {
  if (!config.employeeGroupId) return;
  const who = `${escapeHtml(driverName)}${unitNumber ? ` (Unit ${escapeHtml(unitNumber)})` : ''}`;
  const text = `🎉 <b>${who}</b> is home after <b>${daysOnRoad} days</b> on the road — `
    + `<b>${totalWeeks} week${totalWeeks === 1 ? '' : 's'}</b> total. Great dedication out there! 🚛💪`;
  try {
    await safeSend(() => telegram.sendMessage(config.employeeGroupId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }));
  } catch (err) {
    // Non-fatal: the trip is already saved and visible in the admin panel.
    console.error('[HOME-TIME] Failed to post recognition to employee group:', err.message);
  }
}

/**
 * Process one driver-group message. Safe to call on every message — it is a
 * no-op unless the text contains a recognizable "Status:" line. Never throws.
 *
 * @param {object} telegram  bot.telegram instance (passed in to avoid a require cycle)
 * @param {object} group     groups row (id, telegram_group_id, group_name, group_type)
 * @param {object} message   Telegram message
 */
async function handleDriverGroupStatus(telegram, group, message) {
  try {
    if (!group || group.group_type !== 'driver') return;
    const text = message?.text || message?.caption || '';
    const newState = parseDriverStatus(text);
    if (!newState) return; // not a status message — ignore

    const settings = await ht.getHomeTimeSettings();
    if (!settings || !settings.enabled) return;

    const eventAt = messageTimestampIso(message);
    const current = await ht.getDriverHomeStatus(group.id);

    // First time we ever see this group: just record where it stands now. We do
    // not invent a bonus for a trip whose start we never observed.
    if (!current) {
      await ht.upsertDriverHomeStatus({
        groupId: group.id,
        telegramGroupId: group.telegram_group_id,
        state: newState,
        stateSince: eventAt,
        lastStatusText: text.slice(0, 500),
        lastStatusAt: eventAt,
      });
      return;
    }

    // Same state again (e.g. repeated "Status: Home") → just touch, no transition.
    if (current.state === newState) {
      await ht.touchDriverHomeStatus({
        groupId: group.id,
        lastStatusText: text.slice(0, 500),
        lastStatusAt: eventAt,
      });
      return;
    }

    // ── A real transition ──
    if (current.state === 'road' && newState === 'home') {
      // Road trip just finished — close it and compute the bonus.
      const { driverName, unitNumber, driverType } = await resolveDriverLabel(group);
      const { daysOnRoad, exceededWeeks, bonusUsd } = computeRoadBonus(
        current.state_since,
        eventAt,
        {
          roadAllowanceWeeks: settings.road_allowance_weeks,
          bonusPerWeek: Number(settings.bonus_per_week),
          driverType,
        }
      );
      await ht.insertRoadHistory({
        groupId: group.id,
        driverName,
        unitNumber,
        roadStartedAt: current.state_since,
        homeArrivedAt: eventAt,
        daysOnRoad,
        exceededWeeks,
        bonusUsd,
      });
      if (exceededWeeks > 0 && homeTimePolicyApplies(driverType)) {
        await postRecognitionToEmployeeGroup(telegram, {
          driverName, unitNumber, daysOnRoad, totalWeeks: Math.floor(daysOnRoad / 7),
        });
      }
      console.log(`[HOME-TIME] ${driverName} (${driverType}) home after ${daysOnRoad}d -> $${bonusUsd} bonus`);
    }
    // home → road needs no calculation; the clock simply starts.

    await ht.upsertDriverHomeStatus({
      groupId: group.id,
      telegramGroupId: group.telegram_group_id,
      state: newState,
      stateSince: eventAt,
      lastStatusText: text.slice(0, 500),
      lastStatusAt: eventAt,
    });
  } catch (err) {
    console.error('[HOME-TIME] handleDriverGroupStatus error:', err.message);
  }
}

/** Best display name + unit for an already-joined driver-status row (no extra query). */
function rowDriverLabel(row) {
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return {
    driverName: name || row.group_name || `Group ${row.group_id}`,
    unitNumber: row.unit_number || null,
    driverType: row.driver_type || inferDriverType(row.group_name || ''),
  };
}

/**
 * Scan every driver group still on the road and post a Bonus Penalty group
 * notification for each newly-crossed full extra week (5th week, 6th week,
 * ...) since the last check — instead of waiting for the driver to come
 * home. Safe to call repeatedly: each group's weeks_bonus_notified watermark
 * makes it a no-op once a week has already been posted.
 */
async function checkRoadBonusMilestones(telegram) {
  const settings = await ht.getHomeTimeSettings();
  if (!settings || !settings.enabled) return { checked: 0, notified: 0 };

  const rows = await ht.listOpenRoadStatuses();
  const nowIso = DateTime.now().toUTC().toISO();
  let notified = 0;

  for (const row of rows) {
    try {
      if (row.group_active === false) continue;
      const { driverName, unitNumber, driverType } = rowDriverLabel(row);
      if (!homeTimePolicyApplies(driverType)) continue;

      const { exceededWeeks } = computeRoadBonus(row.state_since, nowIso, {
        roadAllowanceWeeks: settings.road_allowance_weeks,
        bonusPerWeek: Number(settings.bonus_per_week),
        driverType,
      });
      const newWeeks = newlyCrossedExtraWeeks(exceededWeeks, row.weeks_bonus_notified);
      if (!newWeeks.length) continue;

      for (const weekNumber of newWeeks) {
        await postExtraWeekBonusToGroup(telegram, {
          driverName,
          unitNumber,
          absoluteWeek: Number(settings.road_allowance_weeks) + weekNumber,
          allowanceWeeks: settings.road_allowance_weeks,
          bonusUsd: Number(settings.bonus_per_week),
        });
        // Persist after each successful send so a mid-loop failure (e.g. a
        // Telegram rate limit) leaves the watermark at the last week that
        // actually went out, and the remaining weeks retry on the next tick.
        await ht.setWeeksBonusNotified(row.group_id, weekNumber);
        notified += 1;
      }
    } catch (err) {
      console.error(`[HOME-TIME] Extra-week bonus check failed for group ${row.group_id}:`, err.message);
    }
  }
  return { checked: rows.length, notified };
}

async function schedulerTick() {
  if (schedulerTickRunning) return;
  schedulerTickRunning = true;
  try {
    const result = await checkRoadBonusMilestones(schedulerTelegram);
    if (result.notified > 0) {
      console.log(`[HOME-TIME] Extra-week bonus check: ${result.notified} new notification(s) sent.`);
    }
  } catch (err) {
    console.error('[HOME-TIME] Extra-week bonus scheduler tick error:', err.message);
  } finally {
    schedulerTickRunning = false;
  }
}

function startHomeTimeBonusScheduler(telegram) {
  schedulerTelegram = telegram;
  schedulerStopped = false;
  console.log(
    `[HOME-TIME] Extra-week bonus scheduler started — checking every ${BONUS_CHECK_POLL_MS / 60000} min`
  );
  schedulerTick();
  schedulerTimer = setInterval(() => {
    if (!schedulerStopped) schedulerTick();
  }, BONUS_CHECK_POLL_MS);
  schedulerTimer.unref?.();
}

function stopHomeTimeBonusScheduler() {
  schedulerStopped = true;
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

module.exports = {
  handleDriverGroupStatus,
  checkRoadBonusMilestones,
  startHomeTimeBonusScheduler,
  stopHomeTimeBonusScheduler,
};
