/**
 * Employee birthday wishes: configurable TZ schedule, admin send actions.
 *
 * ONE POST PER EMPLOYEE (owner, 23 October 2026): the company's birthday card
 * with their photo, full first name and American name, captioned with the
 * owner's fixed text and a tag of their Telegram account. The caption is never
 * written by a model. See docs/architecture/employee-birthday-cards.md.
 *
 * EXACTLY ONCE PER EMPLOYEE PER DAY. A scheduled or "send now" pass claims
 * `employee:<day>:<id>` before posting each card, releases it if the post
 * fails, and writes `employee:<day>:<id>:sent` once it is out. Two
 * overlapping passes never post the same card twice; a failure is retried
 * without re-posting the cards that already went out; a claim left by a
 * process that stopped mid-post is taken over after STALE_CLAIM_MINUTES; and
 * an employee added with today's birthday later in the day still gets a card,
 * because nothing marks the whole day as done.
 */
const { DateTime } = require('luxon');
const db = require('../database/db');
const employeesDb = require('../database/companyEmployees');
const config = require('../config/config');
const { bot } = require('../bot/bot');
const { safeSend } = require('./telegramHtml');
const { renderBirthdayCard } = require('./employees/birthdayCard');
const { birthdayCaption } = require('./employees/birthdayText');
const { createDailyWakeTimer } = require('./dailyWakeSchedule');

const DEFAULT_TZ = 'Asia/Tashkent';
// Longer than any one post can take, retries and Telegram's rate-limit waits included.
const STALE_CLAIM_MINUTES = 10;
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

/** Render and post one employee's card. Throws when Telegram refuses it. */
async function postBirthdayCard(employee) {
  const photo = await employeesDb.getPhoto(employee.id);
  let card;
  try {
    card = await renderBirthdayCard(employee, photo);
  } catch (err) {
    // A stored photo that no longer decodes must not cost anyone their
    // birthday: the card goes out with the initials instead.
    if (!photo) throw err;
    console.warn(`[EMP-BIRTHDAY] Photo for employee ${employee.id} unreadable, posting without it:`, err.message);
    card = await renderBirthdayCard(employee, null);
  }
  await safeSend(() => bot.telegram.sendPhoto(
    config.employeeGroupId,
    { source: card, filename: 'happy-birthday.jpg' },
    { caption: birthdayCaption(employee), parse_mode: 'HTML' }
  ));
}

/**
 * May this pass post the card under `key`? No when it was already sent
 * (`<key>:sent`), or when another pass claimed it less than
 * STALE_CLAIM_MINUTES ago and may still be posting it. A claim older than that
 * was left by a process that stopped mid-post (a deploy, a crash), so it is
 * released and taken over — otherwise that employee would get no card all day.
 */
async function claimEmployeeCard(key) {
  if (await db.hasServiceRun('birthday', `${key}:sent`)) return false;
  if (await db.claimServiceRun('birthday', key)) return true;
  if (!(await db.releaseStaleServiceRun('birthday', key, STALE_CLAIM_MINUTES))) return false;
  return db.claimServiceRun('birthday', key);
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

  const dayKey = `employee:${isoDate}`;
  // Written only by the version before per-employee claims (until 23 October
  // 2026), which sent one message for the whole day. Honoured so a deploy on
  // such a day does not post that day's birthdays a second time.
  if (claimDailyRun && await db.hasServiceRun('birthday', dayKey)) {
    return { sent: false, reason: 'already_sent', isoDate, names: formatNamesList(employees) };
  }

  const posted = [];
  const failed = [];
  for (const employee of employees) {
    const key = `${dayKey}:${employee.id}`;
    if (claimDailyRun && !(await claimEmployeeCard(key))) continue;
    try {
      await postBirthdayCard(employee);
      posted.push(employee);
    } catch (err) {
      if (claimDailyRun) await db.unclaimServiceRun('birthday', key).catch(() => {});
      failed.push(employee);
      console.error(`[EMP-BIRTHDAY] Card for employee ${employee.id} failed:`, err.message);
      continue;
    }
    if (claimDailyRun) {
      await db.claimServiceRun('birthday', `${key}:sent`).catch((err) => {
        console.warn(`[EMP-BIRTHDAY] Could not mark employee ${employee.id}'s card as sent:`, err.message);
      });
    }
  }

  if (failed.length) {
    // Thrown so the scheduler retries soon; the cards already posted are marked sent.
    throw new Error(`Could not post the birthday card for: ${formatNamesList(failed)}`);
  }

  if (!posted.length) {
    return { sent: false, reason: 'already_sent', isoDate, names: formatNamesList(employees) };
  }
  const names = formatNamesList(posted);
  console.log(`[EMP-BIRTHDAY] Posted ${posted.length} birthday card(s) to the employee group: ${names}`);
  return { sent: true, reason: 'sent', isoDate, names, count: posted.length };
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
  // No day-level shortcut: completion is per employee, so someone added with
  // today's birthday after the morning's cards went out still gets theirs.
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
