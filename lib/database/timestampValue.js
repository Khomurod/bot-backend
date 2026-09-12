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
  return new Date(ms).toISOString();
}

/**
 * The same question, without the conversion: would this value survive the cast?
 * Used by tests and by callers that want to report the refusal.
 */
function isUsableTimestamp(value) {
  return toTimestampValue(value) !== null;
}

module.exports = { toTimestampValue, isUsableTimestamp, MIN_MS, MAX_MS };
