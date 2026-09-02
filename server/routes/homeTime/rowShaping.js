/**
 * Shaping Home-Time rows for the admin panel — pure functions.
 *
 * Display name, driver type and the group-access row the panel renders,
 * including how long ago each group was last checked. No I/O, so the
 * presentation rules are testable without a database.
 *
 * Split out of server/routes/homeTimeRoutes.js.
 */
const { DateTime } = require('luxon');
const { inferDriverType, isInactiveGroup } = require('../../../lib/drivers/driverProfileParse');
const groupAccess = require('../../../services/groupAccessService');

// Supported efficiency date-range windows (days). 'all' = no lower bound.
const EFFICIENCY_RANGES = { 30: 30, 90: 90, 180: 180 };

function resolveEfficiencySinceIso(rangeParam) {
  const raw = String(rangeParam || 'all').toLowerCase();
  if (raw === 'all' || !EFFICIENCY_RANGES[raw]) return null;
  return DateTime.now().toUTC().minus({ days: EFFICIENCY_RANGES[raw] }).toISO();
}

function displayName(row) {
  if (row.display_name) return row.display_name;
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return name || row.group_name || `Group ${row.group_id}`;
}

function resolveDriverType(row) {
  return row?.driver_type || inferDriverType(row?.group_name || '');
}

function buildDirectoryIndex(rows) {
  return new Map((rows || []).map((row) => [Number(row.group_id), row]));
}

/** Shape a driver-group access row for the admin view (adds the read verdict). */
function shapeAccessRow(row, now) {
  const verdict = groupAccess.computeReadingVerdict({
    memberStatus: row.bot_member_status,
    lastMessageSeenAt: row.last_message_seen_at,
    now,
  });
  return {
    group_id: row.group_id,
    group_name: row.group_name,
    group_type: row.group_type || null,
    driver_name: displayName(row),
    unit_number: row.unit_number || null,
    active: row.active ?? row.group_active,
    inactive: row.inactive ?? isInactiveGroup({
      active: row.active ?? row.group_active,
      group_name: row.group_name,
      status: row.driver_status || row.status,
    }),
    duplicate_conflict: row.duplicate_conflict === true,
    duplicate_resolution: row.duplicate_resolution || 'unique',
    bot_member_status: row.bot_member_status || null,
    bot_access_checked_at: row.bot_access_checked_at,
    last_message_seen_at: row.last_message_seen_at,
    home_state: row.home_state || null,
    reading: verdict.reading,
    reading_level: verdict.level,
    reading_label: verdict.label,
  };
}

function escapeHtmlSafe(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = {
  resolveEfficiencySinceIso,
  displayName,
  resolveDriverType,
  buildDirectoryIndex,
  shapeAccessRow,
  escapeHtmlSafe,
};
