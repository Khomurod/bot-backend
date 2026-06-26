/**
 * Home-Time screenshot import — pure helpers (no DB / config / network), so they
 * can be unit-tested in isolation. Depends only on luxon and the pure
 * driverGroupTitle name matchers.
 */
const { DateTime } = require('luxon');
const { normalizePersonName, driverNamesMatch } = require('./driverGroupTitle');

function isoDateOrNull(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const dt = DateTime.fromISO(s);
  return dt.isValid ? dt.toISODate() : null;
}

function normalizeStatus(value) {
  const s = String(value || '').toLowerCase();
  if (s === 'road' || s.includes('road') || s.includes('rolling')) return 'road';
  if (s === 'home' || s.includes('home')) return 'home';
  return null;
}

/**
 * Best matching group for a parsed driver name (or null). Matches the driver's
 * profile name first, then the group title.
 * @param {string} name
 * @param {Array<{group_id,full_name,group_name}>} candidates
 */
function matchCandidate(name, candidates) {
  if (!normalizePersonName(name)) return null;
  const list = Array.isArray(candidates) ? candidates : [];
  for (const c of list) {
    if (c.full_name && driverNamesMatch(name, c.full_name)) return c;
  }
  for (const c of list) {
    if (c.group_name && driverNamesMatch(name, c.group_name)) return c;
  }
  return null;
}

module.exports = { isoDateOrNull, normalizeStatus, matchCandidate };
