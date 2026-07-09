const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const {
  parseGroupName,
  extractUnitFromGroupName,
} = require('../services/driverGroupTitle');
const {
  parseDriverFromGroupName,
  buildDriverDisplayName,
} = require('../services/driverProfileParse');
const { pool, query, ping } = require('./pool');

// Feature modules extracted from this file. db.js stays the compatibility
// seam: it re-exports every helper below so existing `require('./db')` /
// `require('../database/db')` callers keep working unchanged. New code may
// require the feature modules directly. These modules depend only on
// ./pool — never back on db.js — so the require graph stays acyclic.
const questionsDb = require('./questions');
const dispatchEtaDb = require('./dispatchEta');
const fuelMonitoringDb = require('./fuelMonitoring');
const scheduledMessagesDb = require('./scheduledMessages');
const broadcastsDb = require('./broadcasts');
const leadsDb = require('./leads');
const chatLogsDb = require('./chatLogs');
const aiReportsDb = require('./aiReports');
const employeeBirthdaysDb = require('./employeeBirthdays');
const facebookLeadsDb = require('./facebookLeads');

/**
 * Initialize database tables from schema.sql
 */
async function initializeDatabase() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  try {
    await pool.query(schema);
    console.log('[DB] Database tables verified/created.');

    // Auto-tag employee group if EMPLOYEE_GROUP_ID is set
    if (config.employeeGroupId) {
      await pool.query(
        `UPDATE groups SET group_type = 'employee' WHERE telegram_group_id = $1 AND group_type != 'employee'`,
        [config.employeeGroupId]
      );
    }

    await facebookLeadsDb.seedFacebookLeadAutoMessageDefaults();

    await pool.query(
      `UPDATE groups SET status_source = 'bot'
       WHERE group_type = 'driver' AND status_source IS NULL`
    );

    await employeeBirthdaysDb.ensureEmployeeBirthdaySettings();
  } catch (err) {
    console.error('[DB] Error initializing database:', err.message);
    throw err;
  }
}

// ─── Groups ───

async function upsertGroup(telegramGroupId, groupName) {
  const res = await query(
    `INSERT INTO groups (telegram_group_id, group_name, active, status_source)
     VALUES ($1, $2, TRUE, 'bot')
     ON CONFLICT (telegram_group_id)
     DO UPDATE SET group_name = EXCLUDED.group_name
     RETURNING *`,
    [telegramGroupId, groupName]
  );
  console.log(`[DB] Group upserted: ${groupName} (${telegramGroupId})`);
  return res.rows[0];
}

async function reactivateGroupOnBotJoin(telegramGroupId, groupName) {
  const res = await query(
    `INSERT INTO groups (telegram_group_id, group_name, active, status_source, status_updated_at)
     VALUES ($1, $2, TRUE, 'bot', NOW())
     ON CONFLICT (telegram_group_id)
     DO UPDATE SET
       group_name = EXCLUDED.group_name,
       active = TRUE,
       status_source = 'bot',
       status_updated_at = NOW()
     RETURNING *`,
    [telegramGroupId, groupName]
  );
  console.log(`[DB] Group reactivated on bot join: ${groupName} (${telegramGroupId})`);
  return res.rows[0];
}

async function updateGroupOperationalStatus(groupId, active, source) {
  const res = await query(
    `UPDATE groups
     SET active = $1, status_source = $2, status_updated_at = NOW()
     WHERE id = $3 AND group_type = 'driver'
     RETURNING *`,
    [!!active, source, groupId]
  );
  return res.rows[0];
}

async function setGroupStatusByAdmin(groupId, active) {
  return updateGroupOperationalStatus(groupId, active, 'manual');
}

/** Driver groups eligible for AI status classification (excludes manual locks). */
async function getDriverGroupsForStatusAi() {
  const res = await query(
    `SELECT id, group_name, active, status_source
     FROM groups
     WHERE group_type = 'driver'
       AND (status_source IS NULL OR status_source IS DISTINCT FROM 'manual')
     ORDER BY id`
  );
  return res.rows;
}

async function getAllGroups() {
  const res = await query("SELECT * FROM groups WHERE group_type = 'driver' AND active = TRUE ORDER BY id");
  return res.rows;
}

/** Admin manage list: all | active | inactive driver groups. */
async function getDriverGroupsByActiveFilter(filter) {
  const f = filter === 'all' || filter === 'inactive' ? filter : 'active';
  let activeClause = '';
  if (f === 'active') activeClause = ' AND active = TRUE';
  else if (f === 'inactive') activeClause = ' AND active = FALSE';
  const res = await query(
    `SELECT * FROM groups WHERE group_type = 'driver'${activeClause} ORDER BY id`
  );
  return res.rows;
}

/** Broadcast specific-driver picks: resolve IDs even when inactive. */
async function getGroupsByIdsForAdmin(ids) {
  if (!ids || ids.length === 0) return [];
  const res = await query(
    `SELECT * FROM groups WHERE id = ANY($1) AND group_type = 'driver' ORDER BY id`,
    [ids]
  );
  return res.rows;
}

/** Language targeting with active filter (all | active | inactive). */
async function getDriverGroupsByLanguagesAndActiveFilter(languages, filter) {
  if (!languages || languages.length === 0) return [];
  const f = filter === 'all' || filter === 'inactive' ? filter : 'active';
  let activeClause = '';
  if (f === 'active') activeClause = ' AND active = TRUE';
  else if (f === 'inactive') activeClause = ' AND active = FALSE';
  const res = await query(
    `SELECT * FROM groups WHERE language = ANY($1) AND group_type = 'driver'${activeClause} ORDER BY id`,
    [languages]
  );
  return res.rows;
}

async function deactivateGroup(telegramGroupId) {
  await query(
    `UPDATE groups
     SET active = FALSE, status_source = 'bot', status_updated_at = NOW()
     WHERE telegram_group_id = $1`,
    [telegramGroupId]
  );
  console.log(`[DB] Group deactivated: ${telegramGroupId}`);
}

async function getGroupByTelegramId(telegramGroupId) {
  const res = await query(
    'SELECT * FROM groups WHERE telegram_group_id = $1',
    [telegramGroupId]
  );
  return res.rows[0];
}

/**
 * Groups of a given group_type (e.g. 'employee'). Active-only by default.
 * Used by the creator broadcast panel to target the employee group and any
 * non-driver company groups without hardcoding chat ids.
 */
async function getGroupsByType(groupType, { activeOnly = true } = {}) {
  const activeClause = activeOnly ? ' AND active = TRUE' : '';
  const res = await query(
    `SELECT * FROM groups WHERE group_type = $1${activeClause} ORDER BY id`,
    [groupType]
  );
  return res.rows;
}

/**
 * Non-driver, non-employee company groups (e.g. dispatch/office groups the bot
 * was added to). Active-only. Powers the "other company groups" broadcast preset.
 */
async function getOtherCompanyGroups({ activeOnly = true } = {}) {
  const activeClause = activeOnly ? ' AND active = TRUE' : '';
  const res = await query(
    `SELECT * FROM groups
      WHERE group_type NOT IN ('driver', 'employee')${activeClause}
      ORDER BY id`
  );
  return res.rows;
}

/**
 * Case-insensitive search across ALL group types by name — used by the creator
 * "Send Single Message" flow to let the creator pick one specific group.
 */
async function searchGroupsByName(text, limit = 8) {
  const term = String(text || '').trim();
  if (!term) return [];
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 8, 1), 25);
  const res = await query(
    `SELECT * FROM groups
      WHERE group_name ILIKE $1
      ORDER BY active DESC, id
      LIMIT $2`,
    [`%${term}%`, safeLimit]
  );
  return res.rows;
}

/** Fetch a single group by primary key, regardless of type/active state. */
async function getGroupByIdAnyType(id) {
  const res = await query('SELECT * FROM groups WHERE id = $1 LIMIT 1', [id]);
  return res.rows[0] || null;
}

async function getGroupBySamsaraId(samsaraId) {
  if (!samsaraId) return null;
  const res = await query(
    `SELECT * FROM groups
     WHERE samsara_vehicle_id = $1
       AND group_type = 'driver'
       AND active = TRUE
     LIMIT 1`,
    [String(samsaraId)]
  );
  return res.rows[0] || null;
}

async function setGroupLanguage(groupId, language) {
  const res = await query(
    'UPDATE groups SET language = $1 WHERE id = $2 RETURNING *',
    [language, groupId]
  );
  return res.rows[0];
}

async function setGroupBirthday(groupId, birthday) {
  const res = await query(
    'UPDATE groups SET driver_birthday = $1 WHERE id = $2 RETURNING *',
    [birthday || null, groupId]
  );
  return res.rows[0];
}

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

function splitPersonName(fullName) {
  const tokens = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { first_name: null, last_name: null };
  if (tokens.length === 1) return { first_name: tokens[0], last_name: null };
  return {
    first_name: tokens[0],
    last_name: tokens.slice(1).join(' '),
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

async function updateGroupSamsaraId(groupId, samsaraId) {
  const normalized = samsaraId ? String(samsaraId).trim() : null;
  const res = await query(
    `UPDATE groups
     SET samsara_vehicle_id = $1
     WHERE id = $2
     RETURNING *`,
    [normalized || null, groupId]
  );
  return res.rows[0];
}

async function getGroupsWithBirthdayToday(month, day) {
  const res = await query(
    `SELECT * FROM groups 
     WHERE group_type = 'driver' AND active = TRUE AND driver_birthday IS NOT NULL
     AND EXTRACT(MONTH FROM driver_birthday) = $1 
     AND EXTRACT(DAY FROM driver_birthday) = $2`,
    [month, day]
  );
  return res.rows;
}


// ─── Drivers ───

async function upsertDriver(telegramUserId, username, firstName, lastName) {
  const res = await query(
    `INSERT INTO drivers (telegram_user_id, username, first_name, last_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_user_id)
     DO UPDATE SET username = EXCLUDED.username,
                   first_name = EXCLUDED.first_name,
                   last_name = EXCLUDED.last_name
     RETURNING *`,
    [telegramUserId, username, firstName, lastName]
  );
  return res.rows[0];
}

async function getDriverByTelegramId(telegramUserId) {
  const res = await query(
    'SELECT * FROM drivers WHERE telegram_user_id = $1',
    [telegramUserId]
  );
  return res.rows[0];
}

// ─── Group members (users the bot has SEEN in each group) ───
// The Bot API cannot enumerate a group's member list, so these rows are the
// only "membership" we have: every user an update touches is recorded here
// alongside the global `drivers` upsert. They power the admin "Driver
// Username" dropdown on the Driver Groups popup.

async function upsertGroupMember(groupId, user) {
  const telegramUserId = normalizeTelegramUserId(user?.id ?? user?.telegram_user_id);
  const gid = Number(groupId);
  if (!Number.isInteger(gid) || gid <= 0 || !telegramUserId) return null;
  const res = await query(
    `INSERT INTO group_members (group_id, telegram_user_id, username, first_name, last_name, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (group_id, telegram_user_id)
     DO UPDATE SET username = EXCLUDED.username,
                   first_name = EXCLUDED.first_name,
                   last_name = EXCLUDED.last_name,
                   last_seen_at = NOW()
     RETURNING *`,
    [gid, telegramUserId, user?.username || null, user?.first_name || null, user?.last_name || null]
  );
  return res.rows[0] || null;
}

// Drop the membership row when Telegram tells us the user left the group (the
// global `drivers` row is kept — their id is still useful for mentions).
async function removeGroupMember(groupId, telegramUserId) {
  const id = normalizeTelegramUserId(telegramUserId);
  const gid = Number(groupId);
  if (!Number.isInteger(gid) || gid <= 0 || !id) return;
  await query(
    'DELETE FROM group_members WHERE group_id = $1 AND telegram_user_id = $2',
    [gid, id]
  );
}

async function listGroupMembers(groupId) {
  const res = await query(
    `SELECT group_id, telegram_user_id, username, first_name, last_name, last_seen_at
     FROM group_members
     WHERE group_id = $1
     ORDER BY last_seen_at DESC, telegram_user_id ASC`,
    [Number(groupId)]
  );
  return res.rows;
}

// Look up a captured user by username or (first/last) name so callers can build
// an inline mention for someone referenced only by name. Username matches win
// over name matches; ties break toward the most recently created row.
async function findDriverByName(name) {
  const cleaned = String(name || '').trim().replace(/^@+/, '');
  if (!cleaned) return undefined;
  const full = cleaned.replace(/\s+/g, ' ');
  const res = await query(
    `SELECT *,
            CASE
              WHEN LOWER(username) = LOWER($1) THEN 0
              WHEN LOWER(TRIM(CONCAT_WS(' ', first_name, last_name))) = LOWER($1) THEN 1
              WHEN LOWER(first_name) = LOWER($1) THEN 2
              ELSE 3
            END AS match_rank
       FROM drivers
      WHERE LOWER(username) = LOWER($1)
         OR LOWER(TRIM(CONCAT_WS(' ', first_name, last_name))) = LOWER($1)
         OR LOWER(first_name) = LOWER($1)
      ORDER BY match_rank ASC, created_at DESC
      LIMIT 1`,
    [full]
  );
  return res.rows[0];
}


// ─── Admins ───

async function getAdminByUsername(username) {
  const res = await query('SELECT * FROM admins WHERE username = $1', [username]);
  return res.rows[0];
}

async function createAdmin(username, passwordHash) {
  const res = await query(
    `INSERT INTO admins (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING *`,
    [username, passwordHash]
  );
  return res.rows[0];
}

// ─── Scheduled Messages ───

async function getAllDriverGroups() {
  const res = await query("SELECT * FROM groups WHERE group_type = 'driver' AND active = TRUE ORDER BY id");
  return res.rows;
}


async function getGroupsByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const res = await query(
    `SELECT * FROM groups WHERE id = ANY($1) AND group_type = 'driver' AND active = TRUE ORDER BY id`,
    [ids]
  );
  return res.rows;
}

async function getGroupsByLanguages(languages) {
  if (!languages || languages.length === 0) return [];
  const res = await query(
    `SELECT * FROM groups WHERE language = ANY($1) AND group_type = 'driver' AND active = TRUE ORDER BY id`,
    [languages]
  );
  return res.rows;
}


// ─── Service Run Guard (daily/weekly idempotency) ───
// Claim a logical run so a scheduled task fires exactly once per key
// across restarts and (future) multi-instance deployments.
// Returns `true` if this call successfully claimed the run.
async function claimServiceRun(serviceName, runKey) {
  const res = await query(
    `INSERT INTO service_runs (service_name, run_key)
     VALUES ($1, $2)
     ON CONFLICT (service_name, run_key) DO NOTHING
     RETURNING id`,
    [serviceName, runKey]
  );
  return res.rows.length > 0;
}

async function hasServiceRun(serviceName, runKey) {
  const res = await query(
    'SELECT 1 FROM service_runs WHERE service_name = $1 AND run_key = $2',
    [serviceName, runKey]
  );
  return res.rows.length > 0;
}

// Release a previously-claimed run so it can be retried. Used when a job
// claims a run and then fails to deliver: releasing the claim lets the next
// scheduler tick retry that same day instead of treating the run as
// permanently done (which previously silently dropped birthday wishes).
// Returns `true` if a row was actually removed.
async function unclaimServiceRun(serviceName, runKey) {
  const res = await query(
    'DELETE FROM service_runs WHERE service_name = $1 AND run_key = $2',
    [serviceName, runKey]
  );
  return res.rowCount > 0;
}


// ─── Bot visibility diagnostics ───

// Record that the bot RECEIVED a message from a group. This is the ground-truth
// signal that the bot can actually read the group (privacy mode off / it is an
// admin). Only advances the timestamp forward so out-of-order events are safe.
async function recordGroupMessageSeen(groupId, seenAtIso) {
  try {
    await query(
      `UPDATE groups
       SET last_message_seen_at = $2
       WHERE id = $1
         AND (last_message_seen_at IS NULL OR last_message_seen_at < $2)`,
      [groupId, seenAtIso]
    );
  } catch (err) {
    // Non-fatal: this is a diagnostic signal, never block message handling.
    console.error('[DB] recordGroupMessageSeen failed:', err.message);
  }
}

// Cache the bot's membership role in a group (from Telegram getChatMember).
async function updateGroupBotAccess(groupId, memberStatus, checkedAtIso) {
  const res = await query(
    `UPDATE groups
     SET bot_member_status = $2, bot_access_checked_at = $3
     WHERE id = $1 RETURNING id`,
    [groupId, memberStatus || null, checkedAtIso]
  );
  return res.rows.length > 0;
}

async function listGroupDirectorySourceRows({ includeNonDrivers = true } = {}) {
  const typeClause = includeNonDrivers ? '' : `WHERE g.group_type = 'driver'`;
  const res = await query(
    `SELECT
        g.id AS group_id,
        g.group_name,
        g.telegram_group_id,
        g.group_type,
        g.active AS group_active,
        g.status_source,
        g.status_updated_at,
        g.language AS group_language,
        g.driver_birthday AS group_driver_birthday,
        g.created_at AS group_created_at,
        g.last_message_seen_at,
        g.bot_member_status,
        g.bot_access_checked_at,
        dp.id AS profile_id,
        dp.first_name,
        dp.last_name,
        dp.secondary_first_name,
        dp.secondary_last_name,
        dp.first_name_source,
        dp.last_name_source,
        dp.secondary_first_name_source,
        dp.secondary_last_name_source,
        dp.driver_type,
        dp.driver_type_source,
        dp.status AS profile_status,
        dp.unit_number,
        dp.unit_number_source,
        dp.language AS profile_language,
        dp.date_of_birth,
        dp.date_of_start,
        dp.needs_review,
        dp.backfill_confidence,
        dp.telegram_username,
        dp.telegram_user_id,
        dp.created_at AS profile_created_at,
        dp.updated_at AS profile_updated_at,
        s.state AS home_state,
        s.state_since,
        s.last_status_text,
        s.last_status_at
     FROM groups g
     LEFT JOIN driver_profiles dp ON dp.group_id = g.id
     LEFT JOIN driver_home_status s ON s.group_id = g.id
     ${typeClause}
     ORDER BY g.group_name ASC, g.id ASC`
  );
  return res.rows;
}

// Driver groups with their bot-visibility signals, joined to the driver label
// and the home-time state, for the admin "Bot Group Access" view.
async function listDriverGroupAccess() {
  const res = await query(
    `SELECT g.id AS group_id,
            g.group_name,
            g.telegram_group_id,
            g.group_type,
            g.active,
            g.last_message_seen_at,
            g.bot_member_status,
            g.bot_access_checked_at,
            dp.first_name, dp.last_name, dp.unit_number, dp.status AS driver_status,
            s.state AS home_state, s.last_status_at
     FROM groups g
     LEFT JOIN driver_profiles dp ON dp.group_id = g.id
     LEFT JOIN driver_home_status s ON s.group_id = g.id
     WHERE g.group_type = 'driver'
     ORDER BY g.group_name ASC, g.id ASC`
  );
  return res.rows;
}

// Same as listDriverGroupAccess but for EVERY group (driver + non-driver), so the
// admin can filter the Bot Group Access view by type and active state.
async function listAllGroupAccess() {
  const res = await query(
    `SELECT g.id AS group_id,
            g.group_name,
            g.telegram_group_id,
            g.group_type,
            g.active,
            g.last_message_seen_at,
            g.bot_member_status,
            g.bot_access_checked_at,
            dp.first_name, dp.last_name, dp.unit_number, dp.status AS driver_status,
            s.state AS home_state, s.last_status_at
     FROM groups g
     LEFT JOIN driver_profiles dp ON dp.group_id = g.id
     LEFT JOIN driver_home_status s ON s.group_id = g.id
     ORDER BY g.group_name ASC, g.id ASC`
  );
  return res.rows;
}


module.exports = {
  pool,
  query,
  ping,
  initializeDatabase,
  // Bot visibility diagnostics
  recordGroupMessageSeen,
  updateGroupBotAccess,
  listGroupDirectorySourceRows,
  listDriverGroupAccess,
  listAllGroupAccess,
  // Groups
  upsertGroup,
  reactivateGroupOnBotJoin,
  updateGroupOperationalStatus,
  setGroupStatusByAdmin,
  getDriverGroupsForStatusAi,
  getAllGroups,
  getAllDriverGroups,
  getDriverGroupsByActiveFilter,
  getGroupsByIdsForAdmin,
  getDriverGroupsByLanguagesAndActiveFilter,
  getGroupByTelegramId,
  getGroupsByType,
  getOtherCompanyGroups,
  searchGroupsByName,
  getGroupByIdAnyType,
  getGroupBySamsaraId,
  getDriverProfileByGroupId,
  getDriverProfileById,
  listDriverProfiles,
  upsertDriverProfileByGroupId,
  updateDriverProfile,
  syncGroupFromDriverProfile,
  setGroupLanguage,
  setGroupBirthday,
  updateGroupSamsaraId,
  getGroupsWithBirthdayToday,
  getGroupsByIds,
  getGroupsByLanguages,
  deactivateGroup,
  setDriverProfileTelegramIdentity,
  backfillDriverProfileTelegramUserId,
  // Drivers
  upsertDriver,
  getDriverByTelegramId,
  findDriverByName,
  // Group members (users the bot has seen per group)
  upsertGroupMember,
  removeGroupMember,
  listGroupMembers,
  // Admins
  getAdminByUsername,
  createAdmin,
  // Service run guard
  claimServiceRun,
  hasServiceRun,
  unclaimServiceRun,
  // Feature modules (extracted from this file; same helper names as before)
  ...questionsDb,
  ...dispatchEtaDb,
  ...fuelMonitoringDb,
  ...scheduledMessagesDb,
  ...broadcastsDb,
  ...leadsDb,
  ...chatLogsDb,
  ...aiReportsDb,
  ...employeeBirthdaysDb,
  ...facebookLeadsDb,
};
