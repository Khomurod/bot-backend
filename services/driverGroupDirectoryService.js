const db = require('../database/db');
const {
  buildDriverDisplayName,
  buildNormalizedDriverKey,
  inferDriverType,
  isInactiveGroup,
} = require('./driverProfileParse');

function buildBaseDirectoryRow(row = {}) {
  const displayName = buildDriverDisplayName({
    first_name: row.first_name,
    last_name: row.last_name,
    secondary_first_name: row.secondary_first_name,
    secondary_last_name: row.secondary_last_name,
    fallbackGroupName: row.group_name,
  });
  const primaryDisplayName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || null;
  const secondaryDisplayName = [row.secondary_first_name, row.secondary_last_name].filter(Boolean).join(' ').trim() || null;
  const driverType = row.driver_type || inferDriverType(row.group_name || '');
  const status = row.profile_status || (row.group_active === false ? 'inactive' : 'active');
  const inactive = row.group_type === 'driver'
    ? isInactiveGroup({ active: row.group_active, group_name: row.group_name, status })
    : row.group_active === false;

  return {
    group_id: Number(row.group_id),
    profile_id: row.profile_id ? Number(row.profile_id) : null,
    telegram_group_id: row.telegram_group_id || null,
    raw_group_title: row.group_name || '',
    group_name: row.group_name || '',
    group_type: row.group_type || null,
    group_active: row.group_active !== false,
    status_source: row.status_source || null,
    status_updated_at: row.status_updated_at || null,
    first_name: row.first_name || null,
    last_name: row.last_name || null,
    secondary_first_name: row.secondary_first_name || null,
    secondary_last_name: row.secondary_last_name || null,
    first_name_source: row.first_name_source || null,
    last_name_source: row.last_name_source || null,
    secondary_first_name_source: row.secondary_first_name_source || null,
    secondary_last_name_source: row.secondary_last_name_source || null,
    display_name: displayName || null,
    primary_display_name: primaryDisplayName,
    secondary_display_name: secondaryDisplayName,
    driver_type: driverType,
    driver_type_source: row.driver_type_source || null,
    status,
    inactive,
    telegram_username: row.telegram_username || null,
    telegram_user_id: row.telegram_user_id != null ? String(row.telegram_user_id) : null,
    unit_number: row.unit_number || null,
    unit_number_source: row.unit_number_source || null,
    language: row.profile_language || row.group_language || 'en',
    date_of_birth: row.date_of_birth || row.group_driver_birthday || null,
    date_of_start: row.date_of_start || null,
    needs_review: row.needs_review === true,
    backfill_confidence: row.backfill_confidence,
    bot_member_status: row.bot_member_status || null,
    bot_access_checked_at: row.bot_access_checked_at || null,
    last_message_seen_at: row.last_message_seen_at || null,
    home_state: row.home_state || null,
    state_since: row.state_since || null,
    last_status_text: row.last_status_text || null,
    last_status_at: row.last_status_at || null,
    group_created_at: row.group_created_at || null,
    profile_created_at: row.profile_created_at || null,
    profile_updated_at: row.profile_updated_at || null,
    normalized_driver_key: row.group_type === 'driver'
      ? buildNormalizedDriverKey({
        first_name: row.first_name,
        last_name: row.last_name,
        secondary_first_name: row.secondary_first_name,
        secondary_last_name: row.secondary_last_name,
        fallbackGroupName: row.group_name,
      })
      : null,
  };
}

function buildCanonicalDriverGroups(rows, { operational = false } = {}) {
  const baseRows = (Array.isArray(rows) ? rows : []).map(buildBaseDirectoryRow);
  const duplicateBuckets = new Map();

  for (const row of baseRows) {
    if (row.group_type !== 'driver' || !row.normalized_driver_key) continue;
    if (!duplicateBuckets.has(row.normalized_driver_key)) {
      duplicateBuckets.set(row.normalized_driver_key, []);
    }
    duplicateBuckets.get(row.normalized_driver_key).push(row);
  }

  return baseRows.map((row) => {
    if (row.group_type !== 'driver') {
      return {
        ...row,
        canonical_group_id: row.group_id,
        duplicate_group_count: 1,
        duplicate_active_group_ids: [],
        duplicate_inactive_group_ids: [],
        duplicate_group_ids: [],
        duplicate_conflict: false,
        duplicate_resolution: 'not_driver_group',
        duplicate_review_required: false,
        operational_visible: true,
        suppressed_duplicate: false,
      };
    }

    const bucket = row.normalized_driver_key
      ? (duplicateBuckets.get(row.normalized_driver_key) || [])
      : [];
    const duplicateIds = bucket.map((item) => item.group_id);
    const activeItems = bucket.filter((item) => !item.inactive);
    const inactiveItems = bucket.filter((item) => item.inactive);
    const activeIds = activeItems.map((item) => item.group_id);
    const inactiveIds = inactiveItems.map((item) => item.group_id);
    const singleActiveWinnerId = activeIds.length === 1 ? activeIds[0] : null;
    const duplicateConflict = activeIds.length > 1;
    const suppressedDuplicate = Boolean(
      bucket.length > 1
      && singleActiveWinnerId
      && row.group_id !== singleActiveWinnerId
      && row.inactive
    );
    const reviewReasons = [];
    if (!row.normalized_driver_key) reviewReasons.push('missing_identity');
    if (duplicateConflict) reviewReasons.push('multiple_active_duplicates');

    let duplicateResolution = 'unique';
    if (bucket.length > 1 && singleActiveWinnerId) {
      duplicateResolution = row.group_id === singleActiveWinnerId
        ? 'active_wins'
        : 'suppressed_inactive_duplicate';
    } else if (duplicateConflict) {
      duplicateResolution = 'multiple_active_conflict';
    } else if (bucket.length > 1) {
      duplicateResolution = 'all_inactive_duplicates';
    }

    return {
      ...row,
      canonical_group_id: singleActiveWinnerId || row.group_id,
      duplicate_group_count: bucket.length,
      duplicate_group_ids: duplicateIds,
      duplicate_active_group_ids: activeIds,
      duplicate_inactive_group_ids: inactiveIds,
      duplicate_conflict: duplicateConflict,
      duplicate_resolution: duplicateResolution,
      duplicate_review_required: reviewReasons.length > 0,
      review_reasons: row.needs_review === true ? ['profile_review', ...reviewReasons] : reviewReasons,
      operational_visible: operational ? !suppressedDuplicate : true,
      suppressed_duplicate: suppressedDuplicate,
    };
  });
}

function indexCanonicalDriverGroups(rows, opts = {}) {
  const projected = buildCanonicalDriverGroups(rows, opts);
  return new Map(projected.map((row) => [Number(row.group_id), row]));
}

async function listCanonicalDriverGroups({ operational = false, includeNonDrivers = true } = {}) {
  const rows = await db.listGroupDirectorySourceRows({ includeNonDrivers });
  return buildCanonicalDriverGroups(rows, { operational });
}

module.exports = {
  buildBaseDirectoryRow,
  buildCanonicalDriverGroups,
  indexCanonicalDriverGroups,
  listCanonicalDriverGroups,
};
