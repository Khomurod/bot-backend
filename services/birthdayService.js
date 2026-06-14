const { DateTime } = require('luxon');
const db = require('../database/db');
const { bot } = require('../bot/bot');
const { safeSend } = require('./telegramHtml');

const DRIVER_BIRTHDAY_HOUR = 8;   // 8 AM Central Time
const TZ = 'America/Chicago';

let serviceTimer = null;
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

async function processDriverBirthdays(isoDate, month, day) {
  try {
    const birthdayGroups = await db.getGroupsWithBirthdayToday(month, day);
    if (birthdayGroups.length === 0) return;

    const runKey = `driver:${isoDate}`;
    const claimed = await db.claimServiceRun('birthday', runKey);
    if (!claimed) return;

    console.log(`[BIRTHDAY] Found ${birthdayGroups.length} driver birthday(s) today`);

    for (const group of birthdayGroups) {
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
        console.error(`[BIRTHDAY] Failed to send to ${group.group_name}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[BIRTHDAY] Error processing driver birthdays:', err.message);
  }
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

async function checkAndSendBirthdays() {
  try {
    const now = DateTime.now().setZone(TZ);
    const isoDate = now.toISODate();

    if (!isPastDriverBirthdaySchedule(now)) return;
    if (await db.hasServiceRun('birthday', `driver:${isoDate}`)) return;

    await processDriverBirthdays(isoDate, now.month, now.day);
  } catch (err) {
    console.error('[BIRTHDAY] Tick error:', err.message);
  }
}

function startBirthdayService() {
  console.log(
    `[BIRTHDAY] Driver service started — wishes at ${DRIVER_BIRTHDAY_HOUR}:00 ${TZ}`
  );
  serviceStopped = false;
  checkAndSendBirthdays();
  serviceTimer = setInterval(() => {
    if (!serviceStopped) checkAndSendBirthdays();
  }, 60 * 1000);
}

function stopBirthdayService() {
  serviceStopped = true;
  if (serviceTimer) {
    clearInterval(serviceTimer);
    serviceTimer = null;
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
