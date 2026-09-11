'use strict';

/**
 * When the recruiting team is at work — and therefore when Wenze must stay
 * quiet.
 *
 * Pure. A schedule and an instant in, an answer out. No database, no clock of
 * its own: the caller supplies `at`, which is what makes "is 7pm Friday inside
 * the Monday–Friday 8–6 window" testable without waiting until Friday.
 *
 * THREE DECISIONS WORTH STATING, because each of them is the safe side of a
 * choice that could have gone the other way.
 *
 * NO CONFIGURED HOURS MEANS THE OFFICE IS ALWAYS OPEN. An unconfigured schedule
 * returns `open`, so the after-hours AI never speaks. The opposite default —
 * empty means always closed — would have Wenze answering candidates in a
 * company that had not yet decided it wanted that, on the strength of a form
 * nobody filled in.
 *
 * AN OVERNIGHT WINDOW BELONGS TO THE DAY IT STARTS. `22:00–06:00` on Friday
 * covers Friday night and the small hours of Saturday. The obvious
 * implementation — check the time span, then check today's weekday — gets the
 * span right and the day wrong, and would treat Saturday 02:00 as open because
 * Saturday happens to be listed. `facebook_lead_auto_message_rules` has that
 * bug today; it picks a message template, so the cost is a slightly wrong
 * greeting. Here the cost would be silence when a candidate was owed an answer,
 * so the tail of a window is resolved against the PREVIOUS day.
 *
 * A WINDOW WITH START == END IS A FULL DAY, matching `isTimeInWindow` in
 * services/facebookLeadAutoMessageService.js. Whoever types 00:00–00:00 means
 * "all day", not "never".
 */
const { DateTime } = require('luxon');

const DEFAULT_TIMEZONE = 'America/Chicago';

/** 'HH:MM' or 'HH:MM:SS' → minutes past midnight, or null when unreadable. */
function timeToMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value || '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function minutesToTime(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Luxon weekdays: 1 = Monday … 7 = Sunday. */
const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function normaliseDays(days) {
  const list = Array.isArray(days) ? days.map(Number).filter((d) => d >= 1 && d <= 7) : [];
  return [...new Set(list)].sort((a, b) => a - b);
}

/**
 * One window, cleaned up. Returns null when it cannot be read at all, which is
 * treated as "not a window" rather than as an error: a malformed row must not
 * take the whole schedule down and make the office look closed.
 */
function normaliseWindow(raw) {
  const start = timeToMinutes(raw?.start ?? raw?.start_time_local);
  const end = timeToMinutes(raw?.end ?? raw?.end_time_local);
  if (start === null || end === null) return null;
  const days = normaliseDays(raw?.days ?? raw?.days_of_week);
  return {
    label: String(raw?.label || '').trim() || null,
    // No day list means every day. A window that applies to nothing is not
    // something anybody types on purpose.
    days: days.length ? days : [1, 2, 3, 4, 5, 6, 7],
    start: minutesToTime(start),
    end: minutesToTime(end),
    startMinutes: start,
    endMinutes: end,
  };
}

function normaliseSchedule(schedule) {
  const timezone = String(schedule?.timezone || '').trim() || DEFAULT_TIMEZONE;
  const windows = (Array.isArray(schedule?.windows) ? schedule.windows : [])
    .map(normaliseWindow)
    .filter(Boolean);
  return { timezone, windows };
}

/**
 * Does this window cover `local`?
 *
 * Both halves of an overnight window are tested against the day the window
 * STARTS, which is why the tail asks about yesterday's weekday rather than
 * today's.
 */
function windowCovers(win, local) {
  const minutes = local.hour * 60 + local.minute;
  const today = local.weekday;
  const yesterday = today === 1 ? 7 : today - 1;

  if (win.startMinutes === win.endMinutes) return win.days.includes(today);

  if (win.startMinutes < win.endMinutes) {
    return win.days.includes(today)
      && minutes >= win.startMinutes && minutes < win.endMinutes;
  }

  // Overnight. The evening half is today's window; the morning half is the tail
  // of yesterday's.
  if (minutes >= win.startMinutes) return win.days.includes(today);
  if (minutes < win.endMinutes) return win.days.includes(yesterday);
  return false;
}

/**
 * Is the recruiting team working at `at`?
 *
 * @param {{timezone?: string, windows?: Array}} schedule
 * @param {string|Date} at
 * @returns {{open: boolean, reason: string, window: object|null, localTime: string|null,
 *            timezone: string, nextOpenIso: string|null}}
 */
function evaluateHours(schedule, at) {
  const { timezone, windows } = normaliseSchedule(schedule);

  let local;
  if (at instanceof Date) local = DateTime.fromJSDate(at).setZone(timezone);
  else if (at) local = DateTime.fromISO(String(at), { setZone: true }).setZone(timezone);
  else local = DateTime.now().setZone(timezone);

  if (!local.isValid) {
    // An unreadable instant is not evidence that the office is shut.
    return {
      open: true, reason: 'unreadable_time', window: null,
      localTime: null, timezone, nextOpenIso: null,
    };
  }

  const localTime = local.toFormat('ccc HH:mm');

  if (!windows.length) {
    return {
      open: true, reason: 'no_hours_configured', window: null,
      localTime, timezone, nextOpenIso: null,
    };
  }

  for (const win of windows) {
    if (windowCovers(win, local)) {
      return { open: true, reason: 'inside_window', window: win, localTime, timezone, nextOpenIso: null };
    }
  }

  return {
    open: false,
    reason: 'outside_hours',
    window: null,
    localTime,
    timezone,
    nextOpenIso: nextOpeningAfter(windows, local),
  };
}

/**
 * When the office opens next, as an ISO instant — so a candidate can be told
 * "tomorrow morning" instead of "later", and so the handoff note has a time in
 * it.
 *
 * Walks the next eight days a minute-free step at a time: each day contributes
 * at most one opening per window, and the earliest one after `local` wins.
 * Eight rather than seven so a schedule with a single weekly window still
 * resolves when today IS that day and its window has already passed.
 */
function nextOpeningAfter(windows, local) {
  let best = null;
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const day = local.plus({ days: dayOffset }).startOf('day');
    for (const win of windows) {
      if (!win.days.includes(day.weekday)) continue;
      const opensAt = day.plus({ minutes: win.startMinutes });
      if (opensAt <= local) continue;
      if (!best || opensAt < best) best = opensAt;
    }
  }
  return best ? best.toISO() : null;
}

/** "Mon–Fri 08:00–18:00 (America/Chicago)" — for the admin screen and notices. */
function describeSchedule(schedule) {
  const { timezone, windows } = normaliseSchedule(schedule);
  if (!windows.length) return 'No working hours configured';
  const parts = windows.map((win) => {
    const days = win.days.length === 7 ? 'Every day' : win.days.map((d) => DAY_NAMES[d]).join(', ');
    return `${days} ${win.start}–${win.end}`;
  });
  return `${parts.join('; ')} (${timezone})`;
}

module.exports = {
  DEFAULT_TIMEZONE,
  DAY_NAMES,
  timeToMinutes,
  minutesToTime,
  normaliseWindow,
  normaliseSchedule,
  windowCovers,
  evaluateHours,
  nextOpeningAfter,
  describeSchedule,
};
