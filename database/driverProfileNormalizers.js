/**
 * Pure normalization/mapping helpers for driver profiles: field normalizers,
 * the DB-row -> API-row mapper, and the group-name -> default-profile builder.
 * No database access — everything here is a pure function, shared by
 * database/driverProfiles.js and database/groupMembers.js.
 * Extracted verbatim from database/driverProfiles.js.
 */
const { parseGroupName } = require('../lib/drivers/driverGroupTitle');
const {
  parseDriverFromGroupName,
  buildDriverDisplayName,
} = require('../lib/drivers/driverProfileParse');

function normalizeProfileLanguage(language) {
  return ['en', 'ru', 'uz'].includes(language) ? language : 'en';
}

function normalizeProfileStatus(status) {
  return status === 'inactive' ? 'inactive' : 'active';
}

function normalizeProfileDriverType(driverType) {
  return driverType === 'company_driver' ? 'company_driver' : 'owner';
}

function normalizeProfileFieldSource(value) {
  return ['bot', 'ai', 'manual'].includes(value) ? value : null;
}

// Telegram usernames are case-insensitive and stored without the leading '@'.
// Returns null for empty / invalid input.
function normalizeTelegramUsername(value) {
  if (value == null) return null;
  const cleaned = String(value).trim().replace(/^@+/, '').toLowerCase();
  if (!cleaned) return null;
  // Telegram handles are 5-32 chars of [a-z0-9_]; be lenient but strip junk.
  return /^[a-z0-9_]{3,32}$/.test(cleaned) ? cleaned : cleaned.replace(/[^a-z0-9_]/g, '') || null;
}

// Telegram numeric user ids can exceed 2^53, so they are kept as canonical
// digit strings end-to-end (pg returns BIGINT as string too). Returns null for
// empty / non-numeric input.
function normalizeTelegramUserId(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return /^[1-9]\d*$/.test(s) ? s : null;
}

function parseOptionalDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function mapDriverProfileRow(row) {
  if (!row) return null;
  const full_name = buildDriverDisplayName({
    first_name: row.first_name,
    last_name: row.last_name,
    secondary_first_name: row.secondary_first_name,
    secondary_last_name: row.secondary_last_name,
    fallbackGroupName: row.group_name,
  });
  return {
    ...row,
    full_name,
    secondary_full_name: [row.secondary_first_name, row.secondary_last_name].filter(Boolean).join(' ').trim(),
  };
}


function inferDriverTypeFromGroup(groupName) {
  const parsed = parseGroupName(groupName || '');
  const raw = `${parsed.type || ''} ${groupName || ''}`.toLowerCase();
  if (raw.includes('company driver')) return 'company_driver';
  return 'owner';
}

function buildDefaultProfileFromGroup(group) {
  const parsed = parseDriverFromGroupName(group.group_name || '');
  const hasGaps = !parsed.first_name || !parsed.unit_number;
  const created = group.created_at ? new Date(group.created_at) : null;
  return {
    group_id: group.id,
    first_name: parsed.first_name,
    last_name: parsed.last_name,
    secondary_first_name: parsed.secondary_first_name,
    secondary_last_name: parsed.secondary_last_name,
    first_name_source: parsed.first_name ? 'bot' : null,
    last_name_source: parsed.last_name ? 'bot' : null,
    secondary_first_name_source: parsed.secondary_first_name ? 'bot' : null,
    secondary_last_name_source: parsed.secondary_last_name ? 'bot' : null,
    driver_type: parsed.driver_type || inferDriverTypeFromGroup(group.group_name || ''),
    driver_type_source: 'bot',
    status: group.active === false ? 'inactive' : 'active',
    unit_number: parsed.unit_number,
    unit_number_source: parsed.unit_number ? 'bot' : null,
    language: normalizeProfileLanguage(group.language),
    date_of_birth: parseOptionalDate(group.driver_birthday),
    date_of_start: created && !Number.isNaN(created.getTime()) ? created.toISOString().slice(0, 10) : null,
    needs_review: hasGaps,
    backfill_confidence: hasGaps ? 60 : 95,
  };
}

module.exports = {
  normalizeProfileLanguage,
  normalizeProfileStatus,
  normalizeProfileDriverType,
  normalizeProfileFieldSource,
  normalizeTelegramUsername,
  normalizeTelegramUserId,
  parseOptionalDate,
  mapDriverProfileRow,
  inferDriverTypeFromGroup,
  buildDefaultProfileFromGroup,
};
