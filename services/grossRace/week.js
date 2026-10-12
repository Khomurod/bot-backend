'use strict';

/**
 * The Gross Grand Prix's week, in the office's time zone. Pure.
 *
 * The race counts a load by its delivery appointment, Monday to Monday, the way
 * the dispatchers' board does: Monday 00:00 to the next Monday 00:00 is the
 * week the countdown runs to, and the Monday after is counted as well. Ported
 * from the race display the owner approved (October 2026).
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const partFormats = new Map();

function zoneParts(date, tz) {
  let format = partFormats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    });
    partFormats.set(tz, format);
  }
  const parts = {};
  for (const part of format.formatToParts(date)) parts[part.type] = part.value;
  return {
    y: Number(parts.year), mo: Number(parts.month) - 1, d: Number(parts.day),
    h: Number(parts.hour) % 24, mi: Number(parts.minute), s: Number(parts.second),
    wd: WEEKDAYS.indexOf(parts.weekday),
  };
}

function zoneOffsetMs(date, tz) {
  const p = zoneParts(date, tz);
  return Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s) - (date.getTime() - date.getMilliseconds());
}

/** Midnight of a calendar day in `tz`. Day numbers past the month roll over. */
function zoneMidnight(y, mo, day, tz) {
  const guess = Date.UTC(y, mo, day);
  let at = guess - zoneOffsetMs(new Date(guess), tz);
  at = guess - zoneOffsetMs(new Date(at), tz);
  return new Date(at);
}

/**
 * @returns {{ start: Date, end: Date, countedUntil: Date, label: string,
 *             day: number, dayName: string, tz: string }}
 *   `end` is when the week's race finishes; loads are counted until
 *   `countedUntil`, a day later. `day` is 1 on the first day of the week.
 */
function raceWeek({ weekStart = 'mon', tz = 'America/Chicago', now = new Date() } = {}) {
  const today = zoneParts(now, tz);
  const back = weekStart === 'sun' ? today.wd : (today.wd + 6) % 7;
  const start = zoneMidnight(today.y, today.mo, today.d - back, tz);
  const end = zoneMidnight(today.y, today.mo, today.d - back + 7, tz);
  const countedUntil = zoneMidnight(today.y, today.mo, today.d - back + 8, tz);
  const monthDay = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
  const lastDay = new Date(countedUntil.getTime() - 12 * 3600e3);
  const last = zoneParts(lastDay, tz);
  const label = zoneParts(start, tz).mo === last.mo
    ? `${monthDay.format(start)}–${last.d}`
    : `${monthDay.format(start)} – ${monthDay.format(lastDay)}`;
  return { start, end, countedUntil, label, day: back + 1, dayName: WEEKDAYS[today.wd], tz };
}

module.exports = { raceWeek };
