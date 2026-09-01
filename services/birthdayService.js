const { DateTime } = require('luxon');
const db = require('../database/db');
const { bot } = require('../bot/bot');
const { safeSend } = require('./telegramHtml');
const { createDailyWakeTimer } = require('./dailyWakeSchedule');

const DRIVER_BIRTHDAY_HOUR = 8;   // 8 AM Central Time
const TZ = 'America/Chicago';

let wakeTimer = null;
let serviceStopped = false;

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const { extractDriverNameFromGroupTitle } = require('./driverGroupTitle');

function extractDriverName(groupName) {
  const name = extractDriverNameFromGroupTitle(groupName);
  return name || 'Driver';
}

/**
 * Send today's driver wishes. Returns the number of groups whose send failed
 * (their run claim was released, so they are retried) — the wake scheduler uses
 * it to choose between the fast retry cadence and sleeping until tomorrow.
 */
async function processDriverBirthdays(isoDate, month, day) {
  let failures = 0;
  try {
    const birthdayGroups = await db.getGroupsWithBirthdayToday(month, day);
    if (birthdayGroups.length === 0) return failures;

    console.log(`[BIRTHDAY] Found ${birthdayGroups.length} driver birthday(s) today`);

    for (const group of birthdayGroups) {
      // Per-group idempotency: claim THIS group first (so concurrent ticks
      // can't double-send), then release the claim if the send fails so a
      // later tick the same day retries that group instead of dropping it.
      const runKey = `driver:${group.id}:${isoDate}`;
      const claimed = await db.claimServiceRun('birthday', runKey);
      if (!claimed) continue; // already congratulated today

      const driverName = escapeHtml(extractDriverName(group.group_name));
      const message =
        `🥳🚛 <b>Happy Birthday, ${driverName}!</b> 🚛🥳\n\n` +
        `Today we’re celebrating not just another year, but the miles you’ve conquered, the dedication you show every day, and the reliability you bring to our team. 💪\n\n` +
        `${driverName}, your hard work keeps everything moving forward—literally! From early mornings to long hauls, you handle it all with professionalism and strength. We truly appreciate the commitment and positive energy you bring to the road and to our company. 🌍✨\n\n` +
        `May this year bring you smooth roads, safe journeys, great health, and plenty of reasons to smile both on and off the road. 🛣️😊\n\n` +
        `Enjoy your special day—you’ve earned it! 🎂🎈\n\n` +
        `<b>Happy Birthday and keep on truckin’! 🚚🔥</b>`;

      try {
        await safeSend(
          () => bot.telegram.sendMessage(group.telegram_group_id, message, { parse_mode: 'HTML' })
        );
        console.log(`[BIRTHDAY] Sent wish to ${group.group_name}`);
      } catch (err) {
        failures += 1;
        await db.unclaimServiceRun('birthday', runKey).catch(() => {});
        console.error(`[BIRTHDAY] Failed to send to ${group.group_name} (will retry):`, err.message);
      }
    }
  } catch (err) {
    failures += 1;
    console.error('[BIRTHDAY] Error processing driver birthdays:', err.message);
  }
  return failures;
}

function getDriverBirthdayScheduledTime(isoDate) {
  return DateTime.fromISO(isoDate, { zone: TZ }).set({
    hour: DRIVER_BIRTHDAY_HOUR,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
}

function isPastDriverBirthdaySchedule(now) {
  return now >= getDriverBirthdayScheduledTime(now.toISODate());
}

/**
 * One scheduler pass. Resolves `{ retry }` so a failed send comes back on the
 * fast cadence instead of waiting out the long sleep.
 *
 * Before the send hour this returns without touching the database at all, which
 * is what makes the capped hourly wake essentially free.
 */
async function checkAndSendBirthdays() {
  try {
    const now = DateTime.now().setZone(TZ);
    const isoDate = now.toISODate();

    if (!isPastDriverBirthdaySchedule(now)) return { retry: false };

    // Idempotency is per-group (driver:<groupId>:<isoDate>) inside
    // processDriverBirthdays, so a failed group retries on a later pass without
    // a day-level guard blocking it.
    const failures = await processDriverBirthdays(isoDate, now.month, now.day);
    return { retry: failures > 0 };
  } catch (err) {
    console.error('[BIRTHDAY] Tick error:', err.message);
    return { retry: true };
  }
}

function startBirthdayService() {
  console.log(
    `[BIRTHDAY] Driver service started — wishes at ${DRIVER_BIRTHDAY_HOUR}:00 ${TZ}, `
    + 'waking on schedule instead of polling every minute'
  );
  serviceStopped = false;
  wakeTimer = createDailyWakeTimer({
    label: 'BIRTHDAY',
    runTick: checkAndSendBirthdays,
    now: () => DateTime.now().setZone(TZ),
    scheduledFor: getDriverBirthdayScheduledTime,
  });
  wakeTimer.start();
}

function stopBirthdayService() {
  serviceStopped = true;
  if (wakeTimer) {
    wakeTimer.stop();
    wakeTimer = null;
  }
}

module.exports = {
  startBirthdayService,
  stopBirthdayService,
  checkAndSendBirthdays,
  processDriverBirthdays,
  getDriverBirthdayScheduledTime,
  isPastDriverBirthdaySchedule,
};
