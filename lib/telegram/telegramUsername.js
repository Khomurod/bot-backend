/**
 * Telegram username helpers — a single, shared normalization so dispatch team
 * members, driver profiles, and Route Control authorization all compare the
 * same way.
 *
 * Storage/compare convention (matches driver_profiles.telegram_username and the
 * existing `String(u).replace(/^@/, '').toLowerCase()` idiom used for accounting
 * and home-time approver checks): stored WITHOUT a leading '@' and lowercased;
 * compared case-insensitively. Display adds the '@' back.
 */

/**
 * Normalize a username for storage/compare: strip a leading '@', trim, and
 * lowercase. Returns null for empty/invalid input.
 * @returns {string|null}
 */
function normalizeTelegramUsername(value) {
  const raw = String(value == null ? '' : value).trim().replace(/^@+/, '').trim();
  if (!raw) return null;
  return raw.toLowerCase();
}

/**
 * Basic Telegram username shape check (5–32 chars, letters/digits/underscore).
 * Applied to the normalized form. Lenient by design — we warn, we don't block
 * legitimate-looking handles.
 */
function isValidTelegramUsername(value) {
  const normalized = normalizeTelegramUsername(value);
  if (!normalized) return false;
  return /^[a-z0-9_]{5,32}$/.test(normalized);
}

/** Display form with a single leading '@' (null-safe). */
function formatTelegramUsername(value) {
  const normalized = normalizeTelegramUsername(value);
  return normalized ? `@${normalized}` : null;
}

module.exports = {
  normalizeTelegramUsername,
  isValidTelegramUsername,
  formatTelegramUsername,
};
