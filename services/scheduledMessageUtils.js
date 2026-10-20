const { DateTime } = require('luxon');

const DEFAULT_SCHEDULE_TIMEZONE = 'America/Chicago';
const WEEKDAY_LABELS = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};

function normalizeMediaItems(input) {
  if (!Array.isArray(input)) return [];

  return input
    .flatMap((item) => (Array.isArray(item) ? item : [item]))
    .filter((item) => item && typeof item === 'object' && item.file_id)
    .map((item) => ({
      file_id: item.file_id,
      media_type: item.media_type || item.type || 'photo',
    }))
    .filter((item) => ['photo', 'video'].includes(item.media_type));
}

function isValidTimezone(timezone) {
  if (!timezone || typeof timezone !== 'string') return false;
  return DateTime.now().setZone(timezone).isValid;
}

function normalizeTimezone(timezone) {
  return isValidTimezone(timezone) ? timezone : DEFAULT_SCHEDULE_TIMEZONE;
}

function parseTimeOfDay(timeOfDay) {
  if (typeof timeOfDay !== 'string') return null;
  const match = timeOfDay.trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return {
    hour: parseInt(match[1], 10),
    minute: parseInt(match[2], 10),
  };
}

function computeNextWeeklyOccurrence({
  dayOfWeek,
  timeOfDay,
  timezone = DEFAULT_SCHEDULE_TIMEZONE,
  now = DateTime.now().setZone(timezone),
}) {
  const normalizedTimezone = normalizeTimezone(timezone);
  const localNow = now.setZone(normalizedTimezone);
  const parsedTime = parseTimeOfDay(timeOfDay);
  const weekday = parseInt(dayOfWeek, 10);

  if (!parsedTime || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
    return null;
  }

  let candidate = localNow.startOf('day').set({
    hour: parsedTime.hour,
    minute: parsedTime.minute,
    second: 0,
    millisecond: 0,
  });

  const daysUntilTarget = (weekday - candidate.weekday + 7) % 7;
  candidate = candidate.plus({ days: daysUntilTarget });

  if (candidate <= localNow) {
    candidate = candidate.plus({ days: 7 });
  }

  return candidate;
}

function describeWeeklySchedule(dayOfWeek, timeOfDay, timezone = DEFAULT_SCHEDULE_TIMEZONE) {
  const weekday = parseInt(dayOfWeek, 10);
  const parsedTime = parseTimeOfDay(timeOfDay);
  if (!WEEKDAY_LABELS[weekday] || !parsedTime) return 'Weekly';

  const formattedTime = DateTime.fromObject(
    { hour: parsedTime.hour, minute: parsedTime.minute },
    { zone: normalizeTimezone(timezone) }
  ).toFormat('h:mm a');

  return `Every ${WEEKDAY_LABELS[weekday]} at ${formattedTime} ${normalizeTimezone(timezone)}`;
}

/**
 * A message claimed for sending and never released.
 *
 * `claimScheduledMessage` flips a row to `processing` before the send and the
 * send flips it back. A process that dies in between — a deploy, a restart, the
 * memory watchdog — leaves it `processing` for ever, and nothing else ever
 * looks at it again. One weekly PTI reminder sat like that from May to October
 * 2026, never sent once, while the admin screen showed it as in progress.
 *
 * TWO HOURS PAST ITS TIME IS DEAD, NOT SLOW. The longest broadcast this fleet
 * sends takes minutes, so a claim that old belongs to a process that is gone.
 *
 * NOTHING IS SENT AGAIN FROM HERE. The dead send may have reached some groups
 * already, and repeating it would message those drivers twice:
 *
 *   weekly, missed at most one run   →  the next weekly occurrence, so the
 *                                        schedule carries on next week
 *   weekly, stuck for longer         →  failed: a reminder nobody noticed was
 *                                        silent for weeks is a person's call to
 *                                        restart, not a timer's
 *   one-time                         →  failed, for a person to resend
 */
const STALE_CLAIM_MINUTES = 120;
const WEEKLY_RESUME_WITHIN_DAYS = 8;

/**
 * @param {object} msg  `schedule_type`, the weekly fields, and `days_overdue`
 *   (how long past its `scheduled_at` the stuck run is)
 * @returns {{action: 'reschedule', nextAt: string} | {action: 'fail', reason: string}}
 */
function decideStaleClaim(msg, { now = DateTime.now() } = {}) {
  if ((msg?.schedule_type || 'one_time') !== 'weekly') {
    return { action: 'fail', reason: 'a one-time message whose send was interrupted' };
  }
  const overdue = Number(msg.days_overdue);
  if (!Number.isFinite(overdue) || overdue > WEEKLY_RESUME_WITHIN_DAYS) {
    return { action: 'fail', reason: 'a weekly message that has been stuck for more than a week' };
  }
  const timezone = msg.schedule_timezone || DEFAULT_SCHEDULE_TIMEZONE;
  const next = computeNextWeeklyOccurrence({
    dayOfWeek: msg.weekly_day_of_week,
    timeOfDay: msg.weekly_time_local,
    timezone,
    now: now.setZone(normalizeTimezone(timezone)),
  });
  if (!next) return { action: 'fail', reason: 'a weekly message with an unreadable schedule' };
  return { action: 'reschedule', nextAt: next.toUTC().toISO() };
}

module.exports = {
  DEFAULT_SCHEDULE_TIMEZONE,
  WEEKDAY_LABELS,
  normalizeMediaItems,
  isValidTimezone,
  normalizeTimezone,
  parseTimeOfDay,
  computeNextWeeklyOccurrence,
  describeWeeklySchedule,
  STALE_CLAIM_MINUTES,
  WEEKLY_RESUME_WITHIN_DAYS,
  decideStaleClaim,
};
