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
  normalizePersonName,
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

function splitDriverMembers(fullName) {
  const cleaned = stripStatusWords(fullName);
  const segments = cleaned
    .split(/\s*\/\s*/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (segments.length >= 2) {
    const primary = splitName(segments[0]);
    const secondary = splitName(segments.slice(1).join(' / '));
    return {
      first_name: primary.first_name,
      last_name: primary.last_name,
      secondary_first_name: secondary.first_name,
      secondary_last_name: secondary.last_name,
    };
  }

  const primary = splitName(cleaned);
  return {
    first_name: primary.first_name,
    last_name: primary.last_name,
    secondary_first_name: null,
    secondary_last_name: null,
  };
}

function buildDriverDisplayName({
  first_name,
  last_name,
  secondary_first_name,
  secondary_last_name,
  fallbackGroupName,
} = {}) {
  const primary = [first_name, last_name].filter(Boolean).join(' ').trim();
  const secondary = [secondary_first_name, secondary_last_name].filter(Boolean).join(' ').trim();
  const joined = [primary, secondary].filter(Boolean).join(' / ').trim();
  if (joined) return joined;
  return stripStatusWords(extractDriverNameFromGroupTitle(fallbackGroupName || '') || '') || '';
}

function buildNormalizedDriverKey(fields = {}) {
  const primary = normalizePersonName([fields.first_name, fields.last_name].filter(Boolean).join(' '));
  const secondary = normalizePersonName([fields.secondary_first_name, fields.secondary_last_name].filter(Boolean).join(' '));
  const members = [primary, secondary].filter(Boolean).sort();
  if (members.length) return members.join('|');
  const fallback = normalizePersonName(buildDriverDisplayName(fields));
  return fallback || null;
}

/**
 * Deterministic parse of a group name into profile fields.
 * @returns {{ unit_number, first_name, last_name, driver_type }}
 */
function parseDriverFromGroupName(groupName) {
  const unit_number = extractUnitFromGroupName(groupName) || null;
  const driverName = stripStatusWords(extractDriverNameFromGroupTitle(groupName) || '');
  const {
    first_name,
    last_name,
    secondary_first_name,
    secondary_last_name,
  } = splitDriverMembers(driverName);
  return {
    unit_number,
    first_name,
    last_name,
    secondary_first_name,
    secondary_last_name,
    driver_type: inferDriverType(groupName),
  };
}

module.exports = {
  inferDriverType,
  splitName,
  splitDriverMembers,
  stripStatusWords,
  nameMarkedInactive,
  isInactiveGroup,
  buildDriverDisplayName,
  buildNormalizedDriverKey,
  parseDriverFromGroupName,
};
