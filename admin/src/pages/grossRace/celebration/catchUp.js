/**
 * A one-off: on the day the 4 PM video went live, after four o'clock, a screen
 * that missed the celebration shows it once when it opens (the owner,
 * 16 October 2026: "today, as soon as the update is live"). On the other days
 * nothing changes: 4 PM, the minute itself, or not at all.
 *
 * "Once" is per tab, kept in the tab's own storage, so the reload a new build
 * brings does not show it a second time.
 */
import { CELEBRATION_HOUR } from "./celebrationTime";

export const CATCH_UP_DAYS = new Set(["2026-10-16"]);
const KEY = "grossRace.caughtUp";

const formats = new Map();
function zoneClock(at, tz) {
  let format = formats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    formats.set(tz, format);
  }
  const part = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
  return { day: `${part.year}-${part.month}-${part.day}`, minutes: (Number(part.hour) % 24) * 60 + Number(part.minute) };
}

/** The day to catch up on at `now` (ms), or null: a listed day, after the 4 PM minute. */
export function catchUpDay(now, tz, days = CATCH_UP_DAYS) {
  const { day, minutes } = zoneClock(new Date(now), tz);
  return days.has(day) && minutes > CELEBRATION_HOUR * 60 ? day : null;
}

export function caughtUp(storage, day) {
  try { return storage.getItem(KEY) === day; } catch { return false; }
}

export function markCaughtUp(storage, day) {
  try { storage.setItem(KEY, day); } catch { /* no storage: once per page load */ }
}
