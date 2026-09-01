/**
 * Employee birthday wishes: configurable TZ schedule, AI messages, admin send actions.
 */
const { DateTime } = require('luxon');
const db = require('../database/db');
const config = require('../config/config');
const { bot } = require('../bot/bot');
const { safeSend, sendTelegramHtmlChunks, sanitizeCompanyReportHtmlForTelegram } = require('./telegramHtml');
const { generateEmployeeBirthdayMessage } = require('./employeeBirthdayMessage');
const { createDailyWakeTimer } = require('./dailyWakeSchedule');

const DEFAULT_TZ = 'Asia/Tashkent';
/**
 * Fallback schedule, used only if the settings row cannot be read at all.
 * Mirrors the schema defaults for `employee_birthday_settings` (00:00
 * Asia/Tashkent) so a failed read plans the same wake the database would.
 */
const FALLBACK_SEND = { send_hour: 0, send_minute: 0, timezone: DEFAULT_TZ };

let wakeTimer = null;
let serviceStopped = false;
let tickRunning = false;
// Last settings seen by a tick. The wake planner needs the send hour/zone to
// decide when to come back, and reading them again right after the tick would
// double this service's idle query count for no new information.
let lastKnownSettings = FALLBACK_SEND;

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

  // Claim the day FIRST so two overlapping ticks can never both send (no
  // duplicates), but RELEASE the claim if delivery fails so the next tick
  // retries later the same day instead of silently dropping the wish.
  const runKey = `employee:${isoDate}`;
  if (claimDailyRun) {
    const claimed = await db.claimServiceRun('birthday', runKey);
    if (!claimed) {
      return { sent: false, reason: 'already_sent', isoDate, names: formatNamesList(employees) };
    }
  }

  let message;
  let provider;
  try {
    ({ message, provider } = await generateEmployeeBirthdayMessage(
      employees,
      settings.ai_instructions,
      settings.fallback_template
    ));

    // Sanitize to Telegram-safe HTML so an unsupported tag from the AI can
    // never trigger a 400 parse error that would otherwise burn the day.
    const safeMessage = sanitizeCompanyReportHtmlForTelegram(message);
    await sendTelegramHtmlChunks(bot.telegram, config.employeeGroupId, safeMessage);
  } catch (err) {
    if (claimDailyRun) {
      await db.unclaimServiceRun('birthday', runKey).catch(() => {});
    }
    throw err;
  }

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
  lastKnownSettings = settings || FALLBACK_SEND;
  const tz = settings.timezone || DEFAULT_TZ;
  const now = DateTime.now().setZone(tz);
  const isoDate = now.toISODate();

  if (!isPastEmployeeBirthdaySchedule(now, settings)) return null;
  if (await db.hasServiceRun('birthday', `employee:${isoDate}`)) return null;

  return runEmployeeBirthdayWishes({ claimDailyRun: true });
}

function shouldRunEmployeeBirthdayAt(settings, now) {
  return now.hour === settings.send_hour && now.minute === settings.send_minute;
}

/**
 * One scheduler pass. Resolves `{ retry }`: a failed send throws out of
 * `runEmployeeBirthdayWishes` after releasing its day claim, so it must come
 * back on the fast cadence rather than sleeping until the next send hour.
 */
async function tick() {
  if (tickRunning) return { retry: false };
  tickRunning = true;
  try {
    await checkAndRunScheduled();
    return { retry: false };
  } catch (err) {
    console.error('[EMP-BIRTHDAY] Tick error:', err.message);
    return { retry: true };
  } finally {
    tickRunning = false;
  }
}

/** The configured send moment on `isoDate`, from the last settings a tick saw. */
function scheduledForIsoDate(isoDate) {
  return getEmployeeBirthdayScheduledTime(isoDate, lastKnownSettings);
}

function startEmployeeBirthdayWishService() {
  db.getEmployeeBirthdaySettings().then((settings) => {
    if (settings) lastKnownSettings = settings;
    const pad = (n) => String(n).padStart(2, '0');
    console.log(
      `[EMP-BIRTHDAY] Service started — wishes at ${pad(settings.send_hour)}:${pad(settings.send_minute)} ${settings.timezone}`
    );
  }).catch((err) => {
    console.warn('[EMP-BIRTHDAY] Could not load settings:', err.message);
  });

  serviceStopped = false;
  wakeTimer = createDailyWakeTimer({
    label: 'EMP-BIRTHDAY',
    runTick: tick,
    // Each tick refreshes lastKnownSettings, so an admin changing the send
    // time is picked up on the following wake — at most one hour later.
    now: () => DateTime.now().setZone(lastKnownSettings.timezone || DEFAULT_TZ),
    scheduledFor: scheduledForIsoDate,
  });
  wakeTimer.start();
}

function stopEmployeeBirthdayWishService() {
  serviceStopped = true;
  if (wakeTimer) {
    wakeTimer.stop();
    wakeTimer = null;
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
