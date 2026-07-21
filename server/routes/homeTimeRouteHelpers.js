/**
 * Pure request-parsing helpers for the Home-Time admin API
 * (server/routes/homeTimeRoutes.js). Kept side-effect free so they can be unit
 * tested and so the route file stays under the maintainability line limit.
 */
const { DateTime } = require('luxon');

/** Accept a YYYY-MM-DD or full ISO datetime; return a UTC ISO string or null. */
function parseDateInput(value) {
  if (value == null || value === '') return null;
  const str = String(value);
  let dt = DateTime.fromISO(str, { zone: 'utc' });
  if (!dt.isValid && /^\d{4}-\d{2}-\d{2}$/.test(str)) {
    dt = DateTime.fromISO(`${str}T00:00:00`, { zone: 'utc' });
  }
  return dt.isValid ? dt.toISO() : null;
}

/** Accept only a calendar date; return YYYY-MM-DD or null. */
function parseDateOnly(value) {
  if (value == null || value === '') return null;
  const str = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const dt = DateTime.fromISO(str);
  return dt.isValid ? dt.toISODate() : null;
}

/**
 * Normalize the completed-notification Telegram chat id for storage.
 *   - '' (empty) → clears the setting;
 *   - a valid numeric chat id (optionally negative) → the trimmed string;
 *   - anything else → null, signalling an invalid value the caller must reject.
 */
function normalizeNotifyGroupId(value) {
  if (value == null) return '';
  const raw = String(value).trim();
  if (raw === '') return '';
  return /^-?\d+$/.test(raw) ? raw : null;
}

module.exports = { parseDateInput, parseDateOnly, normalizeNotifyGroupId };
