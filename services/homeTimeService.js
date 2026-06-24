/**
 * Driver Home-Time Tracking service.
 *
 * Event-driven: the bot's group-message handler calls handleDriverGroupStatus()
 * for every message in a driver group. We look for "Status: Home / Ready /
 * Rolling", keep a simple home/road state machine per driver group, and — when
 * a driver comes home after more than the allowed weeks on the road — record the
 * trip and post the earned bonus to the "Bonus Penalty For Drivers" group.
 *
 * No timers or scheduler: there is nothing to poll. The settings row is seeded
 * by schema.sql, so there is no startup step either.
 */
const { DateTime } = require('luxon');
const db = require('../database/db');
const ht = require('../database/homeTime');
const { safeSend } = require('./telegramHtml');
const { BONUS_GROUP_CHAT_ID } = require('./mileageBonusConstants');
const { parseDriverStatus, computeRoadBonus } = require('./homeTimeConstants');

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
    };
  } catch (err) {
    return { driverName: group.group_name || `Group ${group.id}`, unitNumber: null };
  }
}

async function postBonusToGroup(telegram, {
  driverName, unitNumber, daysOnRoad, exceededWeeks, bonusUsd, allowanceWeeks,
}) {
  const who = `${escapeHtml(driverName)}${unitNumber ? ` (Unit ${escapeHtml(unitNumber)})` : ''}`;
  const text = `🏠 <b>${who} is home.</b>\n`
    + `On the road for <b>${daysOnRoad} days</b> — that's <b>${exceededWeeks} full week(s)</b> over the ${allowanceWeeks}-week limit.\n`
    + `Qualifies for a <b>$${Number(bonusUsd).toFixed(0)} bonus</b>.`;
  try {
    await safeSend(() => telegram.sendMessage(BONUS_GROUP_CHAT_ID, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }));
  } catch (err) {
    // Non-fatal: the trip + bonus are already saved and visible in the admin panel.
    console.error('[HOME-TIME] Failed to post bonus to group:', err.message);
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
      const { daysOnRoad, exceededWeeks, bonusUsd } = computeRoadBonus(
        current.state_since,
        eventAt,
        {
          roadAllowanceWeeks: settings.road_allowance_weeks,
          bonusPerWeek: Number(settings.bonus_per_week),
        }
      );
      const { driverName, unitNumber } = await resolveDriverLabel(group);
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
      if (bonusUsd > 0) {
        await postBonusToGroup(telegram, {
          driverName, unitNumber, daysOnRoad, exceededWeeks, bonusUsd,
          allowanceWeeks: settings.road_allowance_weeks,
        });
      }
      console.log(`[HOME-TIME] ${driverName} home after ${daysOnRoad}d → $${bonusUsd} bonus`);
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

module.exports = {
  handleDriverGroupStatus,
};
