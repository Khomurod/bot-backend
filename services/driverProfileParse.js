/**
 * Driver-profile parsing from Telegram group names — pure helpers (no DB / AI),
 * so they can be unit-tested and used as the deterministic fallback when the AI
 * parser is unavailable.
 *
 * The rule for driver type comes straight from how the company names its groups:
 *   - A COMPANY DRIVER's group name says so, e.g.
 *       "WENZE UNIT # 008 ABDINASIR / IBRAHIM (COMPANY DRIVERS)"
 *       "WENZE UNIT # 2614 TERRELL DALTON (COMPANY DRIVER)"
 *   - An OWNER OPERATOR's group name says nothing special, e.g.
 *       "WENZE UNIT # 310 JAKHONGIR ABDUNABIEV"
 */
const {
  extractUnitFromGroupName,
  extractDriverNameFromGroupTitle,
} = require('./driverGroupTitle');

/** company_driver iff the name marks it as a company driver; else owner. */
function inferDriverType(groupName) {
  return /company\s+drivers?/i.test(String(groupName || '')) ? 'company_driver' : 'owner';
}

/**
 * Remove standalone status words ("ACTIVE" / "INACTIVE") that operators append
 * to a group name — they are a status marker, not part of the driver's name.
 * e.g. "GOCHYYEV INACTIVE" → "GOCHYYEV".
 */
function stripStatusWords(name) {
  return String(name || '')
    .replace(/\b(in)?active\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when a group name carries the trailing "INACTIVE" marker. */
function nameMarkedInactive(name) {
  return /\binactive\b/i.test(String(name || ''));
}

/**
 * Whether a driver group should be treated as inactive: an explicit inactive
 * profile status, an inactive group flag, or the "INACTIVE" name marker.
 */
function isInactiveGroup({ active, group_name, status } = {}) {
  if (status === 'inactive') return true;
  if (active === false) return true;
  return nameMarkedInactive(group_name);
}

function splitName(fullName) {
  const tokens = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { first_name: null, last_name: null };
  if (tokens.length === 1) return { first_name: tokens[0], last_name: null };
  return { first_name: tokens[0], last_name: tokens.slice(1).join(' ') };
}

/**
 * Deterministic parse of a group name into profile fields.
 * @returns {{ unit_number, first_name, last_name, driver_type }}
 */
function parseDriverFromGroupName(groupName) {
  const unit_number = extractUnitFromGroupName(groupName) || null;
  const driverName = stripStatusWords(extractDriverNameFromGroupTitle(groupName) || '');
  const { first_name, last_name } = splitName(driverName);
  return {
    unit_number,
    first_name,
    last_name,
    driver_type: inferDriverType(groupName),
  };
}

module.exports = {
  inferDriverType,
  splitName,
  stripStatusWords,
  nameMarkedInactive,
  isInactiveGroup,
  parseDriverFromGroupName,
};
