/**
 * Driver profiles: the per-group driver identity record (names, unit, type,
 * status, language, dates, Telegram identity) and the group-row sync that
 * keeps `groups` consistent with a profile change. Pure normalization/
 * mapping helpers live in ./driverProfileNormalizers.
 * Extracted verbatim from database/db.js; db.js re-exports these.
 */
const { query } = require('./pool');
const {
  normalizeProfileLanguage,
  normalizeProfileStatus,
  normalizeProfileDriverType,
  normalizeProfileFieldSource,
  normalizeTelegramUsername,
  normalizeTelegramUserId,
  parseOptionalDate,
  mapDriverProfileRow,
  buildDefaultProfileFromGroup,
} = require('./driverProfileNormalizers');

async function syncGroupFromDriverProfile(profileRow, opts = {}) {
  if (!profileRow?.group_id) return null;
  const syncStatus = opts.syncStatus === true;
  const groupStatusActive = profileRow.status !== 'inactive';
  const sets = [
    'language = $1',
    'driver_birthday = $2',
  ];
  const values = [
    profileRow.language || 'en',
    profileRow.date_of_birth || null,
  ];

  if (syncStatus) {
    values.push(groupStatusActive);
    sets.unshift(`active = $${values.length}`);
    if (opts.groupStatusSource) {
      values.push(opts.groupStatusSource);
      sets.push(`status_source = $${values.length}`);
      sets.push('status_updated_at = NOW()');
    }
  }

  values.push(profileRow.group_id);
  const res = await query(
    `UPDATE groups
     SET ${sets.join(', ')}
     WHERE id = $${values.length}
     RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function getDriverProfileByGroupId(groupId) {
  const res = await query(
    `SELECT dp.*, g.group_name, g.telegram_group_id, g.status_source
     FROM driver_profiles dp
     JOIN groups g ON g.id = dp.group_id
     WHERE dp.group_id = $1
     LIMIT 1`,
    [groupId]
  );
  return mapDriverProfileRow(res.rows[0] || null);
}

async function getDriverProfileById(id) {
  const res = await query(
    `SELECT dp.*, g.group_name, g.telegram_group_id, g.status_source
     FROM driver_profiles dp
     JOIN groups g ON g.id = dp.group_id
     WHERE dp.id = $1
     LIMIT 1`,
    [id]
  );
  return mapDriverProfileRow(res.rows[0] || null);
}

async function listDriverProfiles(filters = {}) {
  const includeInactive = filters.includeInactive === true;
  const needsReviewOnly = filters.needsReviewOnly === true;

  const groupRes = await query(
    `SELECT id, group_name, telegram_group_id, active, language, driver_birthday, created_at
     FROM groups
     WHERE group_type = 'driver'
       ${includeInactive ? '' : 'AND active = TRUE'}
     ORDER BY id ASC`
  );
  const groups = groupRes.rows || [];
  if (groups.length > 0) {
    const groupIds = groups.map((g) => g.id);
    const existingRes = await query(
      `SELECT group_id FROM driver_profiles WHERE group_id = ANY($1)`,
      [groupIds]
    );
    const existingByGroupId = new Set(existingRes.rows.map((r) => Number(r.group_id)));
    for (const group of groups) {
      if (existingByGroupId.has(Number(group.id))) continue;
      const seed = buildDefaultProfileFromGroup(group);
      await upsertDriverProfileByGroupId(seed, { syncGroup: false });
    }
  }

  const clauses = ['g.group_type = \'driver\''];
  const params = [];

  if (!includeInactive) {
    clauses.push('g.active = TRUE');
  }
  if (needsReviewOnly) {
    clauses.push('dp.needs_review = TRUE');
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const res = await query(
    `SELECT
      dp.*,
      g.group_name,
      g.telegram_group_id,
      g.active AS group_active,
      g.language AS group_language,
      g.status_source,
      g.created_at AS group_created_at
     FROM driver_profiles dp
     JOIN groups g ON g.id = dp.group_id
     ${whereSql}
     ORDER BY g.id ASC`,
    params
  );
  return res.rows.map(mapDriverProfileRow);
}

async function upsertDriverProfileByGroupId(data, opts = {}) {
  const normalized = {
    group_id: Number(data.group_id),
    first_name: data.first_name ? String(data.first_name).trim() : null,
    last_name: data.last_name ? String(data.last_name).trim() : null,
    secondary_first_name: data.secondary_first_name ? String(data.secondary_first_name).trim() : null,
    secondary_last_name: data.secondary_last_name ? String(data.secondary_last_name).trim() : null,
    first_name_source: normalizeProfileFieldSource(data.first_name_source),
    last_name_source: normalizeProfileFieldSource(data.last_name_source),
    secondary_first_name_source: normalizeProfileFieldSource(data.secondary_first_name_source),
    secondary_last_name_source: normalizeProfileFieldSource(data.secondary_last_name_source),
    driver_type: normalizeProfileDriverType(data.driver_type),
    driver_type_source: normalizeProfileFieldSource(data.driver_type_source),
    status: normalizeProfileStatus(data.status),
    unit_number: data.unit_number ? String(data.unit_number).trim() : null,
    unit_number_source: normalizeProfileFieldSource(data.unit_number_source),
    language: normalizeProfileLanguage(data.language),
    date_of_birth: parseOptionalDate(data.date_of_birth),
    date_of_start: parseOptionalDate(data.date_of_start),
    needs_review: data.needs_review === true,
    backfill_confidence: Number.isInteger(data.backfill_confidence) ? data.backfill_confidence : null,
    telegram_username: normalizeTelegramUsername(data.telegram_username),
    telegram_user_id: normalizeTelegramUserId(data.telegram_user_id),
  };

  const res = await query(
    `INSERT INTO driver_profiles (
       group_id, first_name, last_name, secondary_first_name, secondary_last_name,
       first_name_source, last_name_source, secondary_first_name_source, secondary_last_name_source,
       driver_type, driver_type_source, status, unit_number, unit_number_source,
       language, date_of_birth, date_of_start, needs_review, backfill_confidence,
       telegram_username, telegram_user_id, created_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9,
       $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19,
       $20, $21, NOW(), NOW()
     )
     ON CONFLICT (group_id)
     DO UPDATE SET
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       secondary_first_name = EXCLUDED.secondary_first_name,
       secondary_last_name = EXCLUDED.secondary_last_name,
       first_name_source = EXCLUDED.first_name_source,
       last_name_source = EXCLUDED.last_name_source,
       secondary_first_name_source = EXCLUDED.secondary_first_name_source,
       secondary_last_name_source = EXCLUDED.secondary_last_name_source,
       driver_type = EXCLUDED.driver_type,
       driver_type_source = EXCLUDED.driver_type_source,
       status = EXCLUDED.status,
       unit_number = EXCLUDED.unit_number,
       unit_number_source = EXCLUDED.unit_number_source,
       language = EXCLUDED.language,
       date_of_birth = EXCLUDED.date_of_birth,
       date_of_start = EXCLUDED.date_of_start,
       needs_review = EXCLUDED.needs_review,
       backfill_confidence = EXCLUDED.backfill_confidence,
       -- Never wipe the admin-selected Telegram identity when other writers
       -- (AI sync, backfill) upsert without one. Setting/clearing is done via
       -- setDriverProfileTelegramIdentity().
       telegram_username = COALESCE(EXCLUDED.telegram_username, driver_profiles.telegram_username),
       telegram_user_id = COALESCE(EXCLUDED.telegram_user_id, driver_profiles.telegram_user_id),
       updated_at = NOW()
     RETURNING *`,
    [
      normalized.group_id,
      normalized.first_name,
      normalized.last_name,
      normalized.secondary_first_name,
      normalized.secondary_last_name,
      normalized.first_name_source,
      normalized.last_name_source,
      normalized.secondary_first_name_source,
      normalized.secondary_last_name_source,
      normalized.driver_type,
      normalized.driver_type_source,
      normalized.status,
      normalized.unit_number,
      normalized.unit_number_source,
      normalized.language,
      normalized.date_of_birth,
      normalized.date_of_start,
      normalized.needs_review,
      normalized.backfill_confidence,
      normalized.telegram_username,
      normalized.telegram_user_id,
    ]
  );
  const row = res.rows[0] || null;
  if (!row) return null;
  if (opts.syncGroup !== false) {
    await syncGroupFromDriverProfile(row, {
      syncStatus: opts.syncStatus === true,
      groupStatusSource: opts.groupStatusSource || null,
    });
  }
  return getDriverProfileByGroupId(row.group_id);
}

async function updateDriverProfile(id, data, opts = {}) {
  const existing = await getDriverProfileById(id);
  if (!existing) return null;
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(data || {}, key);
  const merged = {
    group_id: existing.group_id,
    first_name: hasOwn('first_name') ? data.first_name : existing.first_name,
    last_name: hasOwn('last_name') ? data.last_name : existing.last_name,
    secondary_first_name: hasOwn('secondary_first_name') ? data.secondary_first_name : existing.secondary_first_name,
    secondary_last_name: hasOwn('secondary_last_name') ? data.secondary_last_name : existing.secondary_last_name,
    first_name_source: hasOwn('first_name_source') ? data.first_name_source : existing.first_name_source,
    last_name_source: hasOwn('last_name_source') ? data.last_name_source : existing.last_name_source,
    secondary_first_name_source: hasOwn('secondary_first_name_source') ? data.secondary_first_name_source : existing.secondary_first_name_source,
    secondary_last_name_source: hasOwn('secondary_last_name_source') ? data.secondary_last_name_source : existing.secondary_last_name_source,
    driver_type: hasOwn('driver_type') ? data.driver_type : existing.driver_type,
    driver_type_source: hasOwn('driver_type_source') ? data.driver_type_source : existing.driver_type_source,
    status: hasOwn('status') ? data.status : existing.status,
    unit_number: hasOwn('unit_number') ? data.unit_number : existing.unit_number,
    unit_number_source: hasOwn('unit_number_source') ? data.unit_number_source : existing.unit_number_source,
    language: hasOwn('language') ? data.language : existing.language,
    date_of_birth: hasOwn('date_of_birth') ? data.date_of_birth : existing.date_of_birth,
    date_of_start: hasOwn('date_of_start') ? data.date_of_start : existing.date_of_start,
    needs_review: hasOwn('needs_review') ? data.needs_review : existing.needs_review,
    backfill_confidence: hasOwn('backfill_confidence') ? data.backfill_confidence : existing.backfill_confidence,
  };
  for (const [field, sourceField] of [
    ['first_name', 'first_name_source'],
    ['last_name', 'last_name_source'],
    ['secondary_first_name', 'secondary_first_name_source'],
    ['secondary_last_name', 'secondary_last_name_source'],
    ['driver_type', 'driver_type_source'],
    ['unit_number', 'unit_number_source'],
  ]) {
    if (hasOwn(field) && !hasOwn(sourceField)) {
      merged[sourceField] = 'manual';
    }
  }
  const saved = await upsertDriverProfileByGroupId(merged, {
    ...opts,
    syncStatus: hasOwn('status'),
    groupStatusSource: hasOwn('status') ? (opts.groupStatusSource || 'manual') : (opts.groupStatusSource || null),
  });
  // The upsert COALESCE-preserves the Telegram identity so AI sync/backfill
  // can never wipe it; an explicit set/clear therefore goes through the
  // direct UPDATE below.
  if (saved && (hasOwn('telegram_user_id') || hasOwn('telegram_username'))) {
    return setDriverProfileTelegramIdentity(saved.group_id, {
      telegramUserId: hasOwn('telegram_user_id') ? data.telegram_user_id : saved.telegram_user_id,
      telegramUsername: hasOwn('telegram_username') ? data.telegram_username : saved.telegram_username,
    });
  }
  return saved;
}

// Set or clear a driver's Telegram identity (numeric user id + username) —
// the single source of truth used to tag the driver in fuel/check-in
// reminders. Direct UPDATE (not the upsert merge) so the admin can
// explicitly clear it.
async function setDriverProfileTelegramIdentity(groupId, { telegramUserId, telegramUsername } = {}) {
  const res = await query(
    `UPDATE driver_profiles
     SET telegram_user_id = $2, telegram_username = $3, updated_at = NOW()
     WHERE group_id = $1
     RETURNING *`,
    [Number(groupId), normalizeTelegramUserId(telegramUserId), normalizeTelegramUsername(telegramUsername)]
  );
  return getDriverProfileByGroupId(Number(groupId)).catch(() => res.rows[0] || null);
}

/**
 * Opportunistically backfill a driver profile's telegram_user_id the first time
 * the bot sees the admin-entered @username actually texting in that driver's
 * group. Enables the more reliable tg://user?id mention for drivers linked by
 * manual username only. Safe by construction:
 *   - fills a NULL telegram_user_id ONLY (never overwrites an admin selection);
 *   - scoped to the driver_profile of the group the message came from, so a
 *     same-username user texting in a different group can never hijack the id;
 *   - matches case-insensitively against the stored (normalized) username.
 * Best-effort; callers ignore failure.
 * @returns {Promise<boolean>} true when a row's id was filled.
 */
async function backfillDriverProfileTelegramUserId({ groupId, telegramUserId, username } = {}) {
  const gid = Number(groupId);
  const id = normalizeTelegramUserId(telegramUserId);
  const uname = normalizeTelegramUsername(username);
  if (!Number.isInteger(gid) || gid <= 0 || !id || !uname) return false;
  const res = await query(
    `UPDATE driver_profiles
        SET telegram_user_id = $2, updated_at = NOW()
      WHERE group_id = $1
        AND telegram_user_id IS NULL
        AND telegram_username IS NOT NULL
        AND LOWER(telegram_username) = $3`,
    [gid, id, uname]
  );
  return (res.rowCount || 0) > 0;
}

module.exports = {
  syncGroupFromDriverProfile,
  getDriverProfileByGroupId,
  getDriverProfileById,
  listDriverProfiles,
  upsertDriverProfileByGroupId,
  updateDriverProfile,
  setDriverProfileTelegramIdentity,
  backfillDriverProfileTelegramUserId,
  // internal normalizer shared with groupMembers.js (not part of the legacy
  // db.js surface, but harmless to expose)
  normalizeTelegramUserId,
};
