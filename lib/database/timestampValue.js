'use strict';

/**
 * A value that is safe to hand to a `timestamptz` parameter.
 *
 * PostgreSQL casts a bound parameter with `$n::timestamptz`, and a string it
 * cannot read is not a null — it is an ERROR that aborts the statement, the
 * transaction and, if nothing catches it, the whole background pass. This is
 * not hypothetical: `home_time_return_watch.load_pickup_at` was bound straight
 * from Datatruck's `order.pickup_time`, a field an external system fills with
 * whatever a dispatcher typed, and one unreadable value stopped the
 * return-to-road watch for every driver behind it in the loop, every twelve
 * minutes, for a day.
 *
 * The contract here is the opposite of `services/liveLocations/shaping.toIso`,
 * deliberately, and the two must not be confused:
 *
 *   shaping.toIso        for DISPLAY. Unreadable input is passed through as
 *                        text, because showing a dispatcher the odd string they
 *                        typed is more useful than showing them nothing.
 *   toTimestampValue     for SQL. Unreadable input becomes **null**, because a
 *                        column that cannot hold it should be empty rather than
 *                        take the statement down.
 *
 * Losing one unreadable appointment time is a smaller loss than losing the
 * pass. When the difference matters, keep the raw text in a TEXT column beside
 * the timestamp — do not widen this.
 */

/** Beyond these, a "timestamp" is a parsing accident rather than a date. */
const MIN_MS = Date.parse('1970-01-01T00:00:00Z');
const MAX_MS = Date.parse('2100-01-01T00:00:00Z');


/** `YYYY-MM-DD` at the start of the string — the only shape that can roll over. */
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})/;

/** Days in a month, with the Gregorian leap rule. */
function daysInMonth(year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * Does the text name a day that exists?
 *
 * Checked by ARITHMETIC, not by re-reading the parsed instant. A round trip
 * has to pick a timezone frame to compare in, and the frame depends on the
 * string — a bare date is UTC, a naive time is local, an explicit offset is
 * neither — so it rejected perfectly good timestamps that carried a zone.
 * Whether 30 February exists is not a question about timezones.
 */
function namesARealDay(text) {
  const named = CALENDAR_DAY.exec(text);
  if (!named) return true;
  const year = Number(named[1]);
  const month = Number(named[2]);
  const day = Number(named[3]);
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

/**
 * @param {*} value  a Date, an ISO string, anything an external API sent
 * @returns {string|null} an ISO-8601 string Postgres always accepts, or null
 */
function toTimestampValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) && ms >= MIN_MS && ms <= MAX_MS ? value.toISOString() : null;
  }
  // A bare number is ambiguous — seconds or milliseconds — and guessing which
  // is how a 2026 timestamp becomes 1970. Only an explicit Date is trusted.
  if (typeof value !== 'string') return null;

  const text = value.trim();
  if (!text) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  // `Date.parse('2026')` succeeds, and so does `Date.parse('7')` in some
  // runtimes. A timestamp needs more than a number to be one.
  if (/^\d{1,4}$/.test(text)) return null;
  if (ms < MIN_MS || ms > MAX_MS) return null;
  // A DAY THAT DOES NOT EXIST IS NOT A DATE. `Date.parse('2026-02-30')` does
  // not fail — it answers 2 March. Storing that is worse than storing nothing:
  // it is a fabricated time that reads as real, and every freshness and
  // lifecycle calculation downstream believes it. So when the input names a
  // calendar day, check that the day survived the round trip.
  if (!namesARealDay(text)) return null;
  return new Date(ms).toISOString();
}

/**
 * The same question, without the conversion: would this value survive the cast?
 * Used by tests and by callers that want to report the refusal.
 */
function isUsableTimestamp(value) {
  return toTimestampValue(value) !== null;
}

/**
 * A value that is safe to hand to a numeric parameter.
 *
 * The same trap as the timestamps, one column type over, and it hides better:
 * Postgres ACCEPTS `NaN` in a `double precision` column and REFUSES it in an
 * `integer` one. So a provider that answers `"unknown"` for a speed gets a NaN
 * stored without complaint, the next pass reads it back, the arithmetic it
 * feeds produces a NaN score — and the score lands in `last_score INTEGER`,
 * which raises `invalid input syntax`. That driver then fails on every pass
 * forever, because the value poisoning the score is the one the previous pass
 * stored.
 *
 * A number that is not a number is missing data, and missing data is null.
 */
function toNumericValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  toTimestampValue, isUsableTimestamp, toNumericValue, MIN_MS, MAX_MS,
};
