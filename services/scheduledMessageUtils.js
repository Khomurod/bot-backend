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

module.exports = {
  DEFAULT_SCHEDULE_TIMEZONE,
  WEEKDAY_LABELS,
  normalizeMediaItems,
  isValidTimezone,
  normalizeTimezone,
  parseTimeOfDay,
  computeNextWeeklyOccurrence,
  describeWeeklySchedule,
};
