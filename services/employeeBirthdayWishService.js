/**
 * Employee birthday wishes: configurable TZ schedule, AI messages, admin send actions.
 */
const { DateTime } = require('luxon');
const db = require('../database/db');
const config = require('../config/config');
const { bot } = require('../bot/bot');
const { safeSend } = require('./telegramHtml');
const { generateEmployeeBirthdayMessage } = require('./employeeBirthdayMessage');

const POLL_MS = 60 * 1000;

let serviceTimer = null;
let serviceStopped = false;
let tickRunning = false;

function formatNamesList(employees) {
  return employees.map((e) => `${e.first_name} ${e.last_name}`.trim()).join(', ');
}

async function runEmployeeBirthdayWishes({ claimDailyRun = false, employeeIds = null } = {}) {
  if (!config.employeeGroupId) {
    return { sent: false, reason: 'no_employee_group' };
  }

  const settings = await db.getEmployeeBirthdaySettings();
  const now = DateTime.now().setZone(settings.timezone || 'Asia/Tashkent');
  const isoDate = now.toISODate();

  let employees;
  if (employeeIds && employeeIds.length > 0) {
    employees = await db.getEmployeeBirthdaysByIds(employeeIds);
  } else {
    employees = await db.getEmployeesWithBirthdayOn(now.month, now.day);
  }

  if (!employees.length) {
    return { sent: false, reason: 'no_birthdays', isoDate };
  }

  if (claimDailyRun) {
    const claimed = await db.claimServiceRun('birthday', `employee:${isoDate}`);
    if (!claimed) {
      return { sent: false, reason: 'already_sent', isoDate, names: formatNamesList(employees) };
    }
  }

  const { message, provider } = await generateEmployeeBirthdayMessage(
    employees,
    settings.ai_instructions,
    settings.fallback_template
  );

  await safeSend(
    () => bot.telegram.sendMessage(config.employeeGroupId, message, { parse_mode: 'HTML' })
  );

  const names = formatNamesList(employees);
  console.log(`[EMP-BIRTHDAY] Sent wish (${provider}) to employee group for: ${names}`);

  return {
    sent: true,
    reason: 'sent',
    isoDate,
    names,
    provider,
    messagePreview: message.slice(0, 200),
    count: employees.length,
  };
}

async function sendCustomEmployeeGroupMessage(message) {
  if (!config.employeeGroupId) {
    throw new Error('EMPLOYEE_GROUP_ID not configured');
  }
  const text = String(message || '').trim();
  if (!text) throw new Error('Message is required');
  if (text.length > 4000) throw new Error('Message too long (max 4000 characters)');

  await safeSend(
    () => bot.telegram.sendMessage(config.employeeGroupId, text, { parse_mode: 'HTML' })
  );

  return { sent: true };
}

function getEmployeeBirthdayScheduledTime(isoDate, settings) {
  const tz = settings.timezone || 'Asia/Tashkent';
  return DateTime.fromISO(isoDate, { zone: tz }).set({
    hour: settings.send_hour,
    minute: settings.send_minute,
    second: 0,
    millisecond: 0,
  });
}

function isPastEmployeeBirthdaySchedule(now, settings) {
  return now >= getEmployeeBirthdayScheduledTime(now.toISODate(), settings);
}

async function checkAndRunScheduled() {
  const settings = await db.getEmployeeBirthdaySettings();
  const tz = settings.timezone || 'Asia/Tashkent';
  const now = DateTime.now().setZone(tz);
  const isoDate = now.toISODate();

  if (!isPastEmployeeBirthdaySchedule(now, settings)) return null;
  if (await db.hasServiceRun('birthday', `employee:${isoDate}`)) return null;

  return runEmployeeBirthdayWishes({ claimDailyRun: true });
}

function shouldRunEmployeeBirthdayAt(settings, now) {
  return now.hour === settings.send_hour && now.minute === settings.send_minute;
}

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await checkAndRunScheduled();
  } catch (err) {
    console.error('[EMP-BIRTHDAY] Tick error:', err.message);
  } finally {
    tickRunning = false;
  }
}

function startEmployeeBirthdayWishService() {
  db.getEmployeeBirthdaySettings().then((settings) => {
    const pad = (n) => String(n).padStart(2, '0');
    console.log(
      `[EMP-BIRTHDAY] Service started — wishes at ${pad(settings.send_hour)}:${pad(settings.send_minute)} ${settings.timezone}`
    );
  }).catch((err) => {
    console.warn('[EMP-BIRTHDAY] Could not load settings:', err.message);
  });

  serviceStopped = false;
  tick();
  serviceTimer = setInterval(() => {
    if (!serviceStopped) tick();
  }, POLL_MS);
}

function stopEmployeeBirthdayWishService() {
  serviceStopped = true;
  if (serviceTimer) {
    clearInterval(serviceTimer);
    serviceTimer = null;
  }
}

module.exports = {
  startEmployeeBirthdayWishService,
  stopEmployeeBirthdayWishService,
  runEmployeeBirthdayWishes,
  sendCustomEmployeeGroupMessage,
  checkAndRunScheduled,
  shouldRunEmployeeBirthdayAt,
  getEmployeeBirthdayScheduledTime,
  isPastEmployeeBirthdaySchedule,
};
