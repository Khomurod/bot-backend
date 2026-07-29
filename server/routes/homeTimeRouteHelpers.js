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

/**
 * Validate a PUT /settings body into a column patch for updateHomeTimeSettings.
 *
 * Pure: returns `{ patch }` on success or `{ error }` with the exact message the
 * route should return as a 400. Keeping it here (rather than inline in the route)
 * makes every bound testable without an HTTP round-trip and keeps the route file
 * under the maintainability line limit.
 *
 * Only keys PRESENT in the body are validated and written, so a partial save from
 * the admin panel never clobbers an unrelated setting.
 */
function buildSettingsPatch(body = {}) {
  const b = body || {};
  const patch = {};

  if (b.enabled !== undefined) patch.enabled = Boolean(b.enabled);

  // Whether the bot may message DRIVER groups at all. Deliberately separate from
  // `enabled`: detection, recording and the approval card keep working when off.
  if (b.driver_clarification_enabled !== undefined) {
    patch.driver_clarification_enabled = Boolean(b.driver_clarification_enabled);
  }

  const ranges = [
    ['road_allowance_weeks', 1, 52, 'road_allowance_weeks must be 1-52'],
    ['home_allowance_days', 1, 60, 'home_allowance_days must be 1-60'],
    ['reminder_first_hours', 1, 168, 'reminder_first_hours must be 1-168 hours'],
    ['reminder_second_hours', 1, 168, 'reminder_second_hours must be 1-168 hours'],
  ];
  for (const [col, min, max, error] of ranges) {
    if (b[col] === undefined) continue;
    const n = Number.parseInt(b[col], 10);
    if (!(n >= min && n <= max)) return { error };
    patch[col] = n;
  }

  if (b.bonus_per_week !== undefined) {
    const n = Number(b.bonus_per_week);
    if (!(n >= 0)) return { error: 'bonus_per_week must be 0 or more' };
    patch.bonus_per_week = n;
  }

  // Telegram chat ids. '' clears the setting. The driver's own group is never
  // used for either of these.
  //   completed_notify_group_id      — completed approval cards
  //   internal_clarification_group_id — the staff "clarify these dates" alert
  //                                     raised while driver messaging is off
  for (const col of ['completed_notify_group_id', 'internal_clarification_group_id']) {
    if (b[col] === undefined) continue;
    const gid = normalizeNotifyGroupId(b[col]);
    if (gid === null) return { error: `${col} must be a numeric Telegram chat id` };
    patch[col] = gid || null;
  }

  return { patch };
}

module.exports = {
  parseDateInput, parseDateOnly, normalizeNotifyGroupId, buildSettingsPatch,
};
