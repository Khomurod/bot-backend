/**
 * Number and time formatting for the Gross Grand Prix displays. Pure.
 * Ported from the race design the owner approved.
 */

const pad = (n) => String(n).padStart(2, "0");

export const money = (n) => "$" + Math.round(n || 0).toLocaleString("en-US");
export const moneyK = (n) => (n >= 1000 ? "$" + String(Math.round(n / 100) / 10) + "k" : "$" + Math.round(n || 0));
export const rpm = (n) => "$" + (n || 0).toFixed(2);
export const percent = (v) => Math.round(v * 100) + "%";
export const titleCase = (text) => String(text || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export function ordinal(n) {
  const suffixes = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
}

/** "2d 04:05:06", or "04:05:06" on the last day. Never negative. */
export function countdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  return (d ? d + "d " : "") + pad(Math.floor((s % 86400) / 3600)) + ":" + pad(Math.floor((s % 3600) / 60)) + ":" + pad(s % 60);
}

export function ago(at, now) {
  const s = (now - at) / 1000;
  if (s < 60) return "just now";
  return s < 3600 ? Math.floor(s / 60) + " min ago" : Math.floor(s / 3600) + " h ago";
}

const dayFormats = new Map();
/** "Mon, Oct 12 – Sun, Oct 18": the race week's first and last day in its time zone. */
export function weekRange(week) {
  let format = dayFormats.get(week.tz);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: week.tz, weekday: "short", month: "short", day: "numeric" });
    dayFormats.set(week.tz, format);
  }
  const lastDay = new Date(Date.parse(week.end) - 12 * 3600e3);
  return format.format(new Date(week.start)) + " – " + format.format(lastDay);
}

const clockFormats = new Map();
/** "3:41 PM" in the office's time zone. */
export function clock(date, tz) {
  let format = clockFormats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
    clockFormats.set(tz, format);
  }
  return format.format(date);
}

/** A round axis maximum for the gross ranking, about seven steps long. */
export function scale(raw) {
  const steps = [1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000, 200000, 250000];
  const step = steps.find((s) => raw / s <= 7) || 500000;
  return Math.ceil(raw / step) * step;
}
