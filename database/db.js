const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const {
  parseGroupName,
  extractUnitFromGroupName,
} = require('../services/driverGroupTitle');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl && config.databaseUrl.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : (config.databaseUrl && (config.databaseUrl.includes('supabase') || config.databaseUrl.includes('neon'))
      ? { rejectUnauthorized: false }
      : false),
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

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

    await seedFacebookLeadAutoMessageDefaults();

    await pool.query(
      `UPDATE groups SET status_source = 'bot'
       WHERE group_type = 'driver' AND status_source IS NULL`
    );

    await ensureEmployeeBirthdaySettings();
  } catch (err) {
    console.error('[DB] Error initializing database:', err.message);
    throw err;
  }
}

/**
 * Query helper with logging
 */
async function query(text, params) {
  try {
    const result = await pool.query(text, params);
    return result;
  } catch (err) {
    console.error('[DB] Query error:', err.message, '\nQuery:', text);
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

function parseOptionalDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function mapDriverProfileRow(row) {
  if (!row) return null;
  return {
    ...row,
    full_name: [row.first_name, row.last_name].filter(Boolean).join(' ').trim(),
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
  const parsed = parseGroupName(group.group_name || '');
  const { first_name, last_name } = splitPersonName(parsed.driver || '');
  const unit_number = extractUnitFromGroupName(group.group_name || '');
  const hasGaps = !first_name || !unit_number;
  const created = group.created_at ? new Date(group.created_at) : null;
  return {
    group_id: group.id,
    first_name,
    last_name,
    driver_type: inferDriverTypeFromGroup(group.group_name || ''),
    status: group.active === false ? 'inactive' : 'active',
    unit_number,
    language: normalizeProfileLanguage(group.language),
    date_of_birth: parseOptionalDate(group.driver_birthday),
    date_of_start: created && !Number.isNaN(created.getTime()) ? created.toISOString().slice(0, 10) : null,
    needs_review: hasGaps,
    backfill_confidence: hasGaps ? 60 : 95,
  };
}

async function syncGroupFromDriverProfile(profileRow) {
  if (!profileRow?.group_id) return null;
  const groupStatusActive = profileRow.status !== 'inactive';
  const res = await query(
    `UPDATE groups
     SET active = $1,
         language = $2,
         driver_birthday = $3
     WHERE id = $4
     RETURNING *`,
    [groupStatusActive, profileRow.language || 'en', profileRow.date_of_birth || null, profileRow.group_id]
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
       g.status_source
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
    driver_type: normalizeProfileDriverType(data.driver_type),
    status: normalizeProfileStatus(data.status),
    unit_number: data.unit_number ? String(data.unit_number).trim() : null,
    language: normalizeProfileLanguage(data.language),
    date_of_birth: parseOptionalDate(data.date_of_birth),
    date_of_start: parseOptionalDate(data.date_of_start),
    needs_review: data.needs_review === true,
    backfill_confidence: Number.isInteger(data.backfill_confidence) ? data.backfill_confidence : null,
  };

  const res = await query(
    `INSERT INTO driver_profiles (
       group_id, first_name, last_name, driver_type, status, unit_number,
       language, date_of_birth, date_of_start, needs_review, backfill_confidence,
       created_at, updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11,
       NOW(), NOW()
     )
     ON CONFLICT (group_id)
     DO UPDATE SET
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       driver_type = EXCLUDED.driver_type,
       status = EXCLUDED.status,
       unit_number = EXCLUDED.unit_number,
       language = EXCLUDED.language,
       date_of_birth = EXCLUDED.date_of_birth,
       date_of_start = EXCLUDED.date_of_start,
       needs_review = EXCLUDED.needs_review,
       backfill_confidence = EXCLUDED.backfill_confidence,
       updated_at = NOW()
     RETURNING *`,
    [
      normalized.group_id,
      normalized.first_name,
      normalized.last_name,
      normalized.driver_type,
      normalized.status,
      normalized.unit_number,
      normalized.language,
      normalized.date_of_birth,
      normalized.date_of_start,
      normalized.needs_review,
      normalized.backfill_confidence,
    ]
  );
  const row = res.rows[0] || null;
  if (!row) return null;
  if (opts.syncGroup !== false) {
    await syncGroupFromDriverProfile(row);
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
    driver_type: hasOwn('driver_type') ? data.driver_type : existing.driver_type,
    status: hasOwn('status') ? data.status : existing.status,
    unit_number: hasOwn('unit_number') ? data.unit_number : existing.unit_number,
    language: hasOwn('language') ? data.language : existing.language,
    date_of_birth: hasOwn('date_of_birth') ? data.date_of_birth : existing.date_of_birth,
    date_of_start: hasOwn('date_of_start') ? data.date_of_start : existing.date_of_start,
    needs_review: hasOwn('needs_review') ? data.needs_review : existing.needs_review,
    backfill_confidence: hasOwn('backfill_confidence') ? data.backfill_confidence : existing.backfill_confidence,
  };
  return upsertDriverProfileByGroupId(merged, opts);
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

// ─── Questions ───

async function createQuestion(translations, options, mediaItems, mediaPosition) {
  // translations: [{ language, question_text }]
  // options: [{ option_order, translations: [{ language, option_text }] }]
  // mediaItems: [{ file_id, media_type }] (optional array, up to 10)
  // mediaPosition: 'above' | 'below' (optional, defaults to 'above')

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const qRes = await client.query(
      `INSERT INTO questions (media_position) VALUES ($1) RETURNING *`,
      [mediaPosition || 'above']
    );
    const question = qRes.rows[0];

    // Insert question translations
    for (const t of translations) {
      await client.query(
        `INSERT INTO question_translations (question_id, language, question_text)
         VALUES ($1, $2, $3)`,
        [question.id, t.language, t.question_text]
      );
    }

    // Insert options and their translations
    for (const opt of options) {
      const oRes = await client.query(
        `INSERT INTO options (question_id, option_order)
         VALUES ($1, $2) RETURNING *`,
        [question.id, opt.option_order]
      );
      const option = oRes.rows[0];

      for (const t of opt.translations) {
        await client.query(
          `INSERT INTO option_translations (option_id, language, option_text)
           VALUES ($1, $2, $3)`,
          [option.id, t.language, t.option_text]
        );
      }
    }

    // Insert media items (if any)
    if (mediaItems && mediaItems.length > 0) {
      for (let i = 0; i < mediaItems.length; i++) {
        const m = mediaItems[i];
        await client.query(
          `INSERT INTO question_media (question_id, file_id, media_type, sort_order)
           VALUES ($1, $2, $3, $4)`,
          [question.id, m.file_id, m.media_type || 'photo', i]
        );
      }
    }

    await client.query('COMMIT');
    console.log(`[DB] Question created: id=${question.id}, media=${mediaItems?.length || 0} file(s)`);
    return question;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] Error creating question (rolled back):', err.message);
    throw err;
  } finally {
    client.release();
  }
}

async function getActiveQuestions() {
  const res = await query(
    `SELECT q.id, q.created_at, q.active,
            json_agg(DISTINCT jsonb_build_object(
              'language', qt.language,
              'question_text', qt.question_text
            )) AS translations
     FROM questions q
     LEFT JOIN question_translations qt ON qt.question_id = q.id
     WHERE q.active = TRUE
     GROUP BY q.id
     ORDER BY q.id DESC`
  );
  return res.rows;
}

async function getAllQuestions() {
  const res = await query(
    `SELECT q.id, q.created_at, q.active, q.media_position,
            (SELECT COUNT(*) FROM question_media qm WHERE qm.question_id = q.id)::int AS media_count,
            json_agg(DISTINCT jsonb_build_object(
              'language', qt.language,
              'question_text', qt.question_text
            )) AS translations
     FROM questions q
     LEFT JOIN question_translations qt ON qt.question_id = q.id
     GROUP BY q.id
     ORDER BY q.id DESC`
  );
  return res.rows;
}

async function getQuestionWithOptions(questionId) {
  const qRes = await query(
    `SELECT q.*, json_agg(DISTINCT jsonb_build_object(
        'language', qt.language,
        'question_text', qt.question_text
     )) AS translations
     FROM questions q
     LEFT JOIN question_translations qt ON qt.question_id = q.id
     WHERE q.id = $1
     GROUP BY q.id`,
    [questionId]
  );

  if (qRes.rows.length === 0) return null;
  const question = qRes.rows[0];

  const oRes = await query(
    `SELECT o.id, o.option_order,
            json_agg(jsonb_build_object(
              'language', ot.language,
              'option_text', ot.option_text
            )) AS translations
     FROM options o
     LEFT JOIN option_translations ot ON ot.option_id = o.id
     WHERE o.question_id = $1
     GROUP BY o.id
     ORDER BY o.option_order`,
    [questionId]
  );

  // Fetch media items ordered by sort_order
  const mRes = await query(
    `SELECT file_id, media_type, sort_order
     FROM question_media
     WHERE question_id = $1
     ORDER BY sort_order ASC`,
    [questionId]
  );

  question.options = oRes.rows;
  question.media_items = mRes.rows; // [{ file_id, media_type, sort_order }]
  return question;
}

async function deactivateQuestion(questionId) {
  await query('UPDATE questions SET active = FALSE WHERE id = $1', [questionId]);
}

// ─── Responses ───

async function saveResponse(driverId, groupId, questionId, optionId) {
  const res = await query(
    `INSERT INTO responses (driver_id, group_id, question_id, option_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (driver_id, question_id) DO NOTHING
     RETURNING *`,
    [driverId, groupId, questionId, optionId]
  );
  if (res.rows.length === 0) {
    console.log(`[DB] Duplicate response ignored: driver=${driverId}, question=${questionId}`);
    return null; // duplicate
  }
  console.log(`[DB] Response saved: driver=${driverId}, question=${questionId}, option=${optionId}`);
  return res.rows[0];
}

async function getQuestionResponses(questionId) {
  const res = await query(
    `SELECT r.*, d.username, d.first_name, d.last_name,
            g.group_name, g.language AS group_language,
            qt.question_text AS english_question,
            ot.option_text AS english_option,
            ot_pick.option_text AS response_text,
            r.answered_at AS created_at
     FROM responses r
     JOIN drivers d ON d.id = r.driver_id
     JOIN groups g ON g.id = r.group_id
     LEFT JOIN question_translations qt ON qt.question_id = r.question_id AND qt.language = 'en'
     LEFT JOIN option_translations ot ON ot.option_id = r.option_id AND ot.language = 'en'
     LEFT JOIN LATERAL (
       SELECT option_text
       FROM option_translations ot2
       WHERE ot2.option_id = r.option_id
       ORDER BY CASE WHEN ot2.language = 'en' THEN 0 ELSE 1 END, ot2.id ASC
       LIMIT 1
     ) ot_pick ON TRUE
     WHERE r.question_id = $1
     ORDER BY r.answered_at DESC`,
    [questionId]
  );
  return res.rows;
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

async function getDriverGroupsWithDispatchEtaSettings() {
  const res = await query(
    `SELECT g.id,
            g.group_name,
            g.telegram_group_id,
            g.language,
            g.active,
            COALESCE(e.enabled, FALSE) AS eta_enabled,
            COALESCE(e.target_mode, 'driver') AS eta_target_mode,
            COALESCE(e.interval_minutes, 60) AS eta_interval_minutes,
            e.next_run_at AS eta_next_run_at,
            e.last_run_at AS eta_last_run_at,
            e.last_status AS eta_last_status,
            e.last_error AS eta_last_error
     FROM groups g
     LEFT JOIN dispatch_eta_updates e ON e.group_id = g.id
     WHERE g.group_type = 'driver'
       AND g.active = TRUE
     ORDER BY g.id ASC`
  );
  return res.rows;
}

async function getDispatchEtaSettingByGroupId(groupId) {
  const res = await query(
    `SELECT *
     FROM dispatch_eta_updates
     WHERE group_id = $1
     LIMIT 1`,
    [groupId]
  );
  return res.rows[0] || null;
}

async function upsertDispatchEtaSetting({
  groupId,
  enabled,
  targetMode = 'driver',
  intervalMinutes,
  nextRunAt = null,
}) {
  const normalizedEnabled = (() => {
    if (typeof enabled === 'boolean') return enabled;
    if (typeof enabled === 'string') {
      const value = enabled.trim().toLowerCase();
      if (value === 'true') return true;
      if (value === 'false') return false;
    }
    if (typeof enabled === 'number') return enabled === 1;
    return false;
  })();
  const normalizedTargetMode = String(targetMode || 'driver').trim().toLowerCase() === 'test'
    ? 'test'
    : 'driver';
  const normalizedInterval = Number.isInteger(intervalMinutes) ? intervalMinutes : 60;
  const res = await query(
    `INSERT INTO dispatch_eta_updates (group_id, enabled, target_mode, interval_minutes, next_run_at, processing, processing_started_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, FALSE, NULL, NOW())
     ON CONFLICT (group_id)
     DO UPDATE SET enabled = EXCLUDED.enabled,
                  target_mode = EXCLUDED.target_mode,
                  interval_minutes = EXCLUDED.interval_minutes,
                  next_run_at = EXCLUDED.next_run_at,
                   processing = FALSE,
                   processing_started_at = NULL,
                   updated_at = NOW()
     RETURNING *`,
    [groupId, normalizedEnabled, normalizedTargetMode, normalizedInterval, nextRunAt]
  );
  return res.rows[0];
}

async function getDispatchEtaGlobalSettings() {
  try {
    const res = await query(
      'SELECT driver_interval_minutes, test_interval_minutes FROM dispatch_eta_global_settings WHERE id = 1'
    );
    if (res.rows[0]) return res.rows[0];
  } catch (err) {
    console.warn('[DB] dispatch_eta_global_settings unavailable:', err.message);
  }
  return { driver_interval_minutes: 60, test_interval_minutes: 60 };
}

async function setDispatchEtaGlobalIntervals(driverMinutes, testMinutes) {
  const res = await query(
    `INSERT INTO dispatch_eta_global_settings (id, driver_interval_minutes, test_interval_minutes, updated_at)
     VALUES (1, $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET
       driver_interval_minutes = EXCLUDED.driver_interval_minutes,
       test_interval_minutes = EXCLUDED.test_interval_minutes,
       updated_at = NOW()
     RETURNING driver_interval_minutes, test_interval_minutes`,
    [driverMinutes, testMinutes]
  );
  return res.rows[0];
}

/** Push stored globals onto every dispatch_eta_updates row by target_mode. */
async function applyDispatchEtaIntervalsFromGlobals() {
  const g = await getDispatchEtaGlobalSettings();
  await query(
    `UPDATE dispatch_eta_updates SET interval_minutes = $1, updated_at = NOW() WHERE target_mode = 'driver'`,
    [g.driver_interval_minutes]
  );
  await query(
    `UPDATE dispatch_eta_updates SET interval_minutes = $1, updated_at = NOW() WHERE target_mode = 'test'`,
    [g.test_interval_minutes]
  );
  return g;
}

async function claimDispatchEtaUpdateByGroupId(groupId) {
  const res = await query(
    `UPDATE dispatch_eta_updates
     SET processing = TRUE,
         processing_started_at = NOW(),
         updated_at = NOW()
     WHERE group_id = $1
       AND enabled = TRUE
       AND (processing = FALSE OR processing_started_at < NOW() - INTERVAL '10 minutes')
     RETURNING *`,
    [groupId]
  );
  return res.rows[0] || null;
}

async function claimDueDispatchEtaUpdates(limit = 20) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 20;
  const res = await query(
    `WITH due AS (
       SELECT id
       FROM dispatch_eta_updates
       WHERE enabled = TRUE
         AND next_run_at IS NOT NULL
         AND next_run_at <= NOW()
         AND (processing = FALSE OR processing_started_at < NOW() - INTERVAL '10 minutes')
       ORDER BY next_run_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE dispatch_eta_updates e
     SET processing = TRUE,
         processing_started_at = NOW(),
         updated_at = NOW()
     FROM due
     WHERE e.id = due.id
     RETURNING e.*`,
    [safeLimit]
  );
  return res.rows;
}

async function completeDispatchEtaUpdateSuccess({
  id,
  nextRunAt,
  lastStatus = 'sent',
  lastPinnedSignature = null,
  cachedPickup = null,
  cachedDelivery = null,
  cachedDestinationQuery = null,
  cachedContextJson = null,
}) {
  const res = await query(
    `UPDATE dispatch_eta_updates
     SET processing = FALSE,
         processing_started_at = NULL,
         last_run_at = NOW(),
         last_status = $2,
         last_error = NULL,
         next_run_at = $3,
         last_pinned_signature = $4,
         cached_pickup = $5,
         cached_delivery = $6,
         cached_destination_query = $7,
         cached_context_json = $8,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      lastStatus,
      nextRunAt,
      lastPinnedSignature,
      cachedPickup,
      cachedDelivery,
      cachedDestinationQuery,
      cachedContextJson ? JSON.stringify(cachedContextJson) : null,
    ]
  );
  return res.rows[0] || null;
}

async function completeDispatchEtaUpdateFailure({ id, nextRunAt, errorMessage }) {
  const res = await query(
    `UPDATE dispatch_eta_updates
     SET processing = FALSE,
         processing_started_at = NULL,
         last_run_at = NOW(),
         last_status = 'failed',
         last_error = $2,
         next_run_at = $3,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, String(errorMessage || 'Unknown ETA update error').slice(0, 1000), nextRunAt]
  );
  return res.rows[0] || null;
}

async function createScheduledMessage(data) {
  const mediaItems = Array.isArray(data.media_items) && data.media_items.length > 0
    ? data.media_items
    : null;
  const firstMedia = mediaItems && mediaItems.length > 0
    ? mediaItems[0]
    : null;
  const res = await query(
    `INSERT INTO scheduled_messages
      (message_text_en, message_text_ru, message_text_uz,
       media_items, media_file_id, media_type, media_position,
       target_type, target_driver_ids, target_languages,
       force_language, scheduled_at, schedule_type, schedule_timezone,
       weekly_day_of_week, weekly_time_local, target_active_filter, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'pending')
     RETURNING *`,
    [
      data.message_text_en, data.message_text_ru || null, data.message_text_uz || null,
      mediaItems ? JSON.stringify(mediaItems) : null,
      data.media_file_id || firstMedia?.file_id || null,
      data.media_type || firstMedia?.media_type || null,
      data.media_position || 'above',
      data.target_type || 'all',
      data.target_driver_ids || null,
      data.target_languages || null,
      data.force_language || null,
      data.scheduled_at,
      data.schedule_type || 'one_time',
      data.schedule_timezone || 'America/Chicago',
      data.weekly_day_of_week || null,
      data.weekly_time_local || null,
      data.target_active_filter || null,
    ]
  );
  console.log(`[DB] Scheduled message created: id=${res.rows[0].id}, at=${data.scheduled_at}`);
  return res.rows[0];
}

async function getPendingScheduledMessages() {
  const res = await query(
    `SELECT * FROM scheduled_messages
     WHERE status = 'pending' AND scheduled_at <= NOW()
     ORDER BY scheduled_at ASC`
  );
  return res.rows;
}

async function getAllScheduledMessages() {
  const res = await query(
    `SELECT * FROM scheduled_messages ORDER BY created_at DESC`
  );
  return res.rows;
}

async function getScheduledMessageById(id) {
  const res = await query('SELECT * FROM scheduled_messages WHERE id = $1', [id]);
  return res.rows[0];
}

async function updateScheduledMessageStatus(id, status) {
  const res = await query(
    'UPDATE scheduled_messages SET status = $1 WHERE id = $2 RETURNING *',
    [status, id]
  );
  return res.rows[0];
}

async function recordRecurringScheduledMessageRun(id, nextScheduledAt, lastRunStatus, markSent = false) {
  const res = await query(
    `UPDATE scheduled_messages
     SET status = 'pending',
         scheduled_at = $2,
         last_run_status = $3,
         last_sent_at = CASE WHEN $4 THEN NOW() ELSE last_sent_at END
     WHERE id = $1
     RETURNING *`,
    [id, nextScheduledAt, lastRunStatus, markSent]
  );
  return res.rows[0];
}

async function claimScheduledMessage(id) {
  const res = await query(
    `UPDATE scheduled_messages
     SET status = 'processing'
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id]
  );
  return res.rows[0] || null;
}

async function deleteScheduledMessage(id) {
  await query('DELETE FROM scheduled_messages WHERE id = $1', [id]);
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

// ─── Broadcast Tracking ───

async function createBroadcast(data) {
  const res = await query(
    `INSERT INTO broadcasts
      (type, message_text_en, message_text_ru, message_text_uz,
       media_items, media_position, parse_mode, buttons,
       target_type, target_driver_ids, target_languages, force_language,
       target_active_filter, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      data.type || 'regular',
      data.message_text_en || null,
      data.message_text_ru || null,
      data.message_text_uz || null,
      data.media_items ? JSON.stringify(data.media_items) : null,
      data.media_position || 'above',
      data.parse_mode || 'HTML',
      data.buttons ? JSON.stringify(data.buttons) : null,
      data.target_type || 'all',
      data.target_driver_ids || null,
      data.target_languages || null,
      data.force_language || null,
      data.target_active_filter || null,
      data.status || 'sent',
    ]
  );
  console.log(`[DB] Broadcast created: id=${res.rows[0].id}, type=${data.type || 'regular'}`);
  return res.rows[0];
}

async function createBroadcastDelivery(data) {
  const res = await query(
    `INSERT INTO broadcast_deliveries
      (broadcast_id, group_id, telegram_group_id, group_name, status, error_message)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      data.broadcast_id,
      data.group_id || null,
      data.telegram_group_id || null,
      data.group_name || null,
      data.status || 'sent',
      data.error_message || null,
    ]
  );
  return res.rows[0];
}

async function getBroadcasts(type) {
  const res = await query(
    `SELECT b.*,
       COUNT(bd.id) FILTER (WHERE bd.status = 'sent') AS sent_count,
       COUNT(bd.id) FILTER (WHERE bd.status = 'failed') AS failed_count
     FROM broadcasts b
     LEFT JOIN broadcast_deliveries bd ON bd.broadcast_id = b.id
     WHERE b.type = $1
     GROUP BY b.id
     ORDER BY b.created_at DESC
     LIMIT 50`,
    [type || 'regular']
  );
  return res.rows;
}

async function getBroadcastDeliveries(broadcastId) {
  const res = await query(
    `SELECT * FROM broadcast_deliveries WHERE broadcast_id = $1 ORDER BY sent_at ASC`,
    [broadcastId]
  );
  return res.rows;
}

async function saveBroadcastButtonClick(data) {
  const res = await query(
    `INSERT INTO broadcast_button_clicks
      (broadcast_id, button_index, button_label, driver_telegram_id,
       driver_username, driver_first_name, driver_last_name,
       group_telegram_id, group_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (broadcast_id, button_index, driver_telegram_id) DO NOTHING
     RETURNING *`,
    [
      data.broadcast_id,
      data.button_index,
      data.button_label || null,
      data.driver_telegram_id,
      data.driver_username || null,
      data.driver_first_name || null,
      data.driver_last_name || null,
      data.group_telegram_id || null,
      data.group_name || null,
    ]
  );
  return res.rows[0] || null; // null means duplicate
}

async function getBroadcastButtonClicks(broadcastId) {
  const res = await query(
    `SELECT * FROM broadcast_button_clicks WHERE broadcast_id = $1 ORDER BY clicked_at DESC`,
    [broadcastId]
  );
  return res.rows;
}

// ─── Chat Logs ───

async function logChatMessage(groupId, telegramUserId, senderName, messageText, telegramMessageId = null) {
  await query(
    `INSERT INTO chat_logs (group_id, telegram_user_id, telegram_message_id, sender_name, message_text)
     VALUES ($1, $2, $3, $4, $5)`,
    [groupId, telegramUserId, telegramMessageId, senderName, messageText]
  );
}

async function upsertGroupPinnedMessageSnapshot({
  groupId,
  telegramGroupId,
  pinnedMessage,
  sourceEventMessageId = null,
  sourceEventAt = null,
}) {
  if (!groupId || !telegramGroupId || !pinnedMessage?.message_id) return null;

  const res = await query(
    `INSERT INTO group_pinned_messages (
       group_id,
       telegram_group_id,
       pinned_message_id,
       pinned_message_json,
       source_event_message_id,
       source_event_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW())
     ON CONFLICT (group_id)
     DO UPDATE SET
       telegram_group_id = EXCLUDED.telegram_group_id,
       pinned_message_id = EXCLUDED.pinned_message_id,
       pinned_message_json = EXCLUDED.pinned_message_json,
       source_event_message_id = EXCLUDED.source_event_message_id,
       source_event_at = EXCLUDED.source_event_at,
       updated_at = NOW()
     WHERE group_pinned_messages.source_event_at IS NULL
        OR EXCLUDED.source_event_at IS NULL
        OR EXCLUDED.source_event_at >= group_pinned_messages.source_event_at
     RETURNING *`,
    [
      groupId,
      telegramGroupId,
      pinnedMessage.message_id,
      JSON.stringify(pinnedMessage),
      sourceEventMessageId,
      sourceEventAt,
    ]
  );

  return res.rows[0] || null;
}

async function getGroupPinnedMessageSnapshot(groupId) {
  if (!groupId) return null;
  const res = await query(
    `SELECT *
     FROM group_pinned_messages
     WHERE group_id = $1
     LIMIT 1`,
    [groupId]
  );
  return res.rows[0] || null;
}

async function getGroupRecentLoads(groupId, limit = 2) {
  if (!groupId) return [];
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 2;
  const res = await query(
    `SELECT *
     FROM group_recent_loads
     WHERE group_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [groupId, safeLimit]
  );
  return res.rows;
}

async function hasGroupRecentLoadForMessage(groupId, telegramMessageId) {
  if (!groupId || telegramMessageId == null) return false;
  const res = await query(
    `SELECT 1 FROM group_recent_loads
     WHERE group_id = $1 AND telegram_message_id = $2
     LIMIT 1`,
    [groupId, telegramMessageId]
  );
  return res.rows.length > 0;
}

async function hasAnyGroupRecentLoadForMessages(groupId, telegramMessageIds) {
  if (!groupId || !Array.isArray(telegramMessageIds) || !telegramMessageIds.length) {
    return false;
  }
  const res = await query(
    `SELECT 1 FROM group_recent_loads
     WHERE group_id = $1 AND telegram_message_id = ANY($2::bigint[])
     LIMIT 1`,
    [groupId, telegramMessageIds]
  );
  return res.rows.length > 0;
}

async function insertGroupRecentLoad(row) {
  const {
    groupId,
    telegramMessageId,
    sourceMessageAt = null,
    contextSignature,
    pickupSummary = '',
    deliverySummary = '',
    destinationQuery = '',
    pickupWindowStart = null,
    pickupWindowEnd = null,
    deliveryWindowStart = null,
    deliveryWindowEnd = null,
    loadIdentifier = null,
    captionPreview = null,
    extractedRawJson = null,
    aiModel = null,
  } = row;

  if (!groupId || !telegramMessageId || !contextSignature) {
    throw new Error('insertGroupRecentLoad: groupId, telegramMessageId, and contextSignature are required');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ins = await client.query(
      `INSERT INTO group_recent_loads (
         group_id,
         telegram_message_id,
         source_message_at,
         context_signature,
         pickup_summary,
         delivery_summary,
         destination_query,
         pickup_window_start,
         pickup_window_end,
         delivery_window_start,
         delivery_window_end,
         load_identifier,
         caption_preview,
         extracted_raw_json,
         ai_model
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)
       ON CONFLICT (group_id, telegram_message_id) DO NOTHING
       RETURNING id`,
      [
        groupId,
        telegramMessageId,
        sourceMessageAt,
        contextSignature,
        pickupSummary,
        deliverySummary,
        destinationQuery,
        pickupWindowStart,
        pickupWindowEnd,
        deliveryWindowStart,
        deliveryWindowEnd,
        loadIdentifier,
        captionPreview,
        extractedRawJson ? JSON.stringify(extractedRawJson) : null,
        aiModel,
      ]
    );

    if (ins.rows.length > 0) {
      await client.query(
        `DELETE FROM group_recent_loads
         WHERE group_id = $1
           AND id NOT IN (
             SELECT id FROM group_recent_loads
             WHERE group_id = $1
             ORDER BY created_at DESC
             LIMIT 2
           )`,
        [groupId]
      );
    }

    await client.query('COMMIT');
    return ins.rows[0] || null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getChatLogsForGroup(groupId, daysBack) {
  const res = await query(
    `SELECT c.*,
            g.group_name,
            g.telegram_group_id
     FROM chat_logs c
     JOIN groups g ON c.group_id = g.id
     WHERE c.group_id = $1 AND c.created_at >= NOW() - ($2 || ' days')::INTERVAL
     ORDER BY c.created_at ASC`,
    [groupId, daysBack]
  );
  return res.rows;
}

async function getChatLogsForActiveDriverGroups(daysBack) {
  const res = await query(
    `SELECT c.*,
            g.group_name,
            g.telegram_group_id
     FROM chat_logs c
     JOIN groups g ON c.group_id = g.id
     WHERE g.group_type = 'driver'
       AND g.active = TRUE
       AND c.created_at >= NOW() - ($1 || ' days')::INTERVAL
     ORDER BY c.created_at ASC`,
    [daysBack]
  );
  return res.rows;
}

async function deleteOldChatLogs(daysOld) {
  const res = await query(
    `DELETE FROM chat_logs WHERE created_at < NOW() - ($1 || ' days')::INTERVAL`,
    [daysOld]
  );
  return res.rowCount || 0;
}

async function getRecentChatLogs(limit = 50) {
  const res = await query(
    `SELECT c.id, c.sender_name, c.message_text, c.created_at, c.telegram_message_id,
            g.group_name, g.telegram_group_id
     FROM chat_logs c
     JOIN groups g ON c.group_id = g.id
     ORDER BY c.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}

// ─── AI Reports ───
async function saveAiReport(groupId, reportText, reportType = 'driver') {
  const normalizedType = reportType === 'company' ? 'company' : 'driver';
  const res = await query(
    `INSERT INTO ai_reports (group_id, report_text, report_type, status)
     VALUES ($1, $2, $3, 'draft')
     RETURNING *`,
    [groupId, reportText, normalizedType]
  );
  return res.rows[0];
}

async function getPendingAiReports(type = 'driver') {
  const normalizedType = type === 'company' ? 'company' : 'driver';
  const res = await query(
    `SELECT ar.*, COALESCE(g.group_name, 'Global Driver Groups') AS group_name
     FROM ai_reports ar
     LEFT JOIN groups g ON g.id = ar.group_id
     WHERE ar.status = 'draft'
       AND ar.report_type = $1
     ORDER BY ar.generated_at DESC`
    , [normalizedType]
  );
  return res.rows;
}

async function getAiReportById(reportId) {
  const res = await query(
    `SELECT ar.*, COALESCE(g.group_name, 'Global Driver Groups') AS group_name
     FROM ai_reports ar
     LEFT JOIN groups g ON g.id = ar.group_id
     WHERE ar.id = $1`,
    [reportId]
  );
  return res.rows[0];
}

async function updateAiReportStatus(reportId, status) {
  const normalized = String(status || '').toLowerCase();
  if (!['draft', 'sent', 'discarded'].includes(normalized)) {
    throw new Error('Invalid ai report status');
  }
  const res = await query(
    `UPDATE ai_reports
     SET status = $1,
         sent_at = CASE WHEN $1 = 'sent' THEN NOW() ELSE sent_at END
     WHERE id = $2
     RETURNING *`,
    [normalized, reportId]
  );
  return res.rows[0];
}

async function discardAiReport(reportId) {
  return updateAiReportStatus(reportId, 'discarded');
}

// ─── AI Insights Pipeline v2 ───────────────────────────────────────
// Sender role consensus. Recomputed before each report by aggregating
// the last N days of per-message role guesses into a confident majority.
async function refreshSenderRoleConsensus(daysBack = 30, groupIds = null) {
  const params = [daysBack];
  let groupClause = '';
  if (Array.isArray(groupIds) && groupIds.length > 0) {
    params.push(groupIds);
    groupClause = `AND cl.group_id = ANY($${params.length}::int[])`;
  }
  const sql = `
    WITH scoped AS (
      SELECT cl.group_id,
             cl.telegram_user_id,
             cl.sender_name,
             a.role_guess,
             a.role_confidence
        FROM chat_logs cl
        JOIN chat_message_annotations a ON a.chat_log_id = cl.id
       WHERE cl.created_at >= NOW() - ($1 || ' days')::INTERVAL
         AND cl.telegram_user_id IS NOT NULL
         ${groupClause}
    ),
    majority AS (
      SELECT group_id, telegram_user_id,
             MAX(sender_name)                                   AS sender_name,
             MODE() WITHIN GROUP (ORDER BY role_guess)          AS role,
             COALESCE(AVG(role_confidence)::INT, 0)             AS confidence,
             COUNT(*)::INT                                      AS message_count
        FROM scoped
       GROUP BY group_id, telegram_user_id
    )
    INSERT INTO sender_role_consensus
      (group_id, telegram_user_id, sender_name, role, confidence, message_count, last_updated)
    SELECT group_id, telegram_user_id, sender_name, role, confidence, message_count, NOW()
      FROM majority
    ON CONFLICT (group_id, telegram_user_id) DO UPDATE
      SET sender_name   = EXCLUDED.sender_name,
          role          = EXCLUDED.role,
          confidence    = EXCLUDED.confidence,
          message_count = EXCLUDED.message_count,
          last_updated  = NOW()
  `;
  const res = await query(sql, params);
  return res.rowCount || 0;
}

async function getSenderRoleConsensus(groupIds = null) {
  if (Array.isArray(groupIds) && groupIds.length > 0) {
    const res = await query(
      `SELECT * FROM sender_role_consensus WHERE group_id = ANY($1::int[])`,
      [groupIds]
    );
    return res.rows;
  }
  const res = await query(`SELECT * FROM sender_role_consensus`);
  return res.rows;
}

// Fetch all annotated messages in window. Used by the insights aggregator
// and by the Ask-the-Data narrative fallback. Includes role consensus so
// downstream code has a single source of truth per-sender.
async function getAnnotatedMessagesForRange({ daysBack = 7, groupIds = null, limit = null } = {}) {
  const params = [daysBack];
  let groupClause = '';
  if (Array.isArray(groupIds) && groupIds.length > 0) {
    params.push(groupIds);
    groupClause = `AND v.group_id = ANY($${params.length}::int[])`;
  }
  let limitClause = '';
  if (Number.isInteger(limit) && limit > 0) {
    params.push(limit);
    limitClause = `LIMIT $${params.length}`;
  }
  const res = await query(
    `SELECT v.*
       FROM v_annotated_messages v
      WHERE v.created_at >= NOW() - ($1 || ' days')::INTERVAL
        ${groupClause}
      ORDER BY v.created_at ASC
      ${limitClause}`,
    params
  );
  return res.rows;
}

// ─── AI Insights (per-card) ───────────────────────────────────────
async function createAiInsight(insight) {
  const {
    report_id,
    kind,
    severity = 1,
    rank = 0,
    title,
    narrative_html = null,
    suggested_action = null,
    evidence_json = null,
    metrics_json = null,
    driver_name = null,
    driver_telegram_id = null,
    group_id = null,
  } = insight;
  const res = await query(
    `INSERT INTO ai_insights
      (report_id, kind, severity, rank, title, narrative_html, suggested_action,
       evidence_json, metrics_json, driver_name, driver_telegram_id, group_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12)
     RETURNING *`,
    [
      report_id,
      kind,
      severity,
      rank,
      title,
      narrative_html,
      suggested_action,
      evidence_json ? JSON.stringify(evidence_json) : null,
      metrics_json ? JSON.stringify(metrics_json) : null,
      driver_name,
      driver_telegram_id,
      group_id,
    ]
  );
  return res.rows[0];
}

async function getInsightsForReport(reportId) {
  const res = await query(
    `SELECT * FROM ai_insights
      WHERE report_id = $1
      ORDER BY
        CASE kind
          WHEN 'pulse' THEN 0
          WHEN 'at_risk' THEN 1
          WHEN 'star' THEN 2
          WHEN 'home_time' THEN 3
          WHEN 'unacked' THEN 4
          WHEN 'silent' THEN 5
          WHEN 'anomaly' THEN 6
          WHEN 'hotspot' THEN 7
          WHEN 'one_on_one' THEN 8
          ELSE 9
        END,
        severity DESC,
        rank ASC,
        id ASC`,
    [reportId]
  );
  return res.rows;
}

async function getInsightById(id) {
  const res = await query(`SELECT * FROM ai_insights WHERE id = $1`, [id]);
  return res.rows[0];
}

async function updateInsightStatus(id, status, feedback = null, patch = null) {
  const normalized = String(status || '').toLowerCase();
  if (!['pending', 'approved', 'dismissed', 'edited', 'sent'].includes(normalized)) {
    throw new Error('Invalid insight status');
  }
  const setParts = ['status = $1', 'updated_at = NOW()'];
  const params = [normalized];
  if (feedback !== null && feedback !== undefined) {
    params.push(String(feedback).slice(0, 500));
    setParts.push(`admin_feedback = $${params.length}`);
  }
  if (patch && typeof patch === 'object') {
    if (typeof patch.title === 'string') {
      params.push(patch.title.slice(0, 300));
      setParts.push(`title = $${params.length}`);
    }
    if (typeof patch.narrative_html === 'string') {
      params.push(patch.narrative_html.slice(0, 20000));
      setParts.push(`narrative_html = $${params.length}`);
    }
    if (typeof patch.suggested_action === 'string') {
      params.push(patch.suggested_action.slice(0, 1000));
      setParts.push(`suggested_action = $${params.length}`);
    }
  }
  params.push(id);
  const res = await query(
    `UPDATE ai_insights SET ${setParts.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  return res.rows[0];
}

async function deleteInsightsForReport(reportId) {
  const res = await query(`DELETE FROM ai_insights WHERE report_id = $1`, [reportId]);
  return res.rowCount || 0;
}

async function upsertEmployeeBirthday(firstName, lastName, birthday) {
  const res = await query(
    `INSERT INTO employee_birthdays (first_name, last_name, birthday)
     VALUES ($1, $2, $3)
     ON CONFLICT (first_name, last_name) DO UPDATE SET birthday = EXCLUDED.birthday
     RETURNING *`,
    [firstName, lastName, birthday]
  );
  return res.rows[0];
}

async function getAllEmployeeBirthdays() {
  const res = await query('SELECT * FROM employee_birthdays ORDER BY created_at DESC');
  return res.rows;
}

async function getEmployeesWithBirthdayOn(month, day) {
  const res = await query(
    `SELECT * FROM employee_birthdays 
     WHERE EXTRACT(MONTH FROM birthday) = $1 AND EXTRACT(DAY FROM birthday) = $2
     ORDER BY last_name, first_name`,
    [month, day]
  );
  return res.rows;
}

async function getEmployeesWithBirthdayToday(month, day) {
  return getEmployeesWithBirthdayOn(month, day);
}

async function getEmployeeBirthdaysByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const res = await query(
    `SELECT * FROM employee_birthdays WHERE id = ANY($1::int[]) ORDER BY last_name, first_name`,
    [ids]
  );
  return res.rows;
}

const DEFAULT_EMPLOYEE_BIRTHDAY_AI_INSTRUCTIONS =
  'Write a warm, professional birthday message for office staff at Wenze. '
  + 'Be sincere and appreciative. Use different wording each time.';

const DEFAULT_EMPLOYEE_BIRTHDAY_FALLBACK =
  '🎉 <b>Happy Birthday!</b> 🎂\n\n'
  + 'Today we celebrate: <b>{names}</b>!\n\n'
  + 'Wishing you a fantastic day and a great year ahead!\n\n'
  + '— <i>Wenze Management</i>';

async function ensureEmployeeBirthdaySettings() {
  const existing = await query('SELECT id FROM employee_birthday_settings WHERE id = 1');
  if (existing.rows.length > 0) return;

  const tz = process.env.EMPLOYEE_BIRTHDAY_TZ || 'Asia/Tashkent';
  const hour = Math.min(23, Math.max(0, parseInt(process.env.EMPLOYEE_BIRTHDAY_HOUR || '0', 10) || 0));
  const minute = Math.min(59, Math.max(0, parseInt(process.env.EMPLOYEE_BIRTHDAY_MINUTE || '0', 10) || 0));

  await query(
    `INSERT INTO employee_birthday_settings (
       id, timezone, send_hour, send_minute, ai_instructions, fallback_template
     ) VALUES (1, $1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
  [
    tz,
    hour,
    minute,
    DEFAULT_EMPLOYEE_BIRTHDAY_AI_INSTRUCTIONS,
    DEFAULT_EMPLOYEE_BIRTHDAY_FALLBACK,
  ]
  );
}

async function getEmployeeBirthdaySettings() {
  await ensureEmployeeBirthdaySettings();
  const res = await query('SELECT * FROM employee_birthday_settings WHERE id = 1');
  return res.rows[0];
}

async function updateEmployeeBirthdaySettings({
  timezone,
  sendHour,
  sendMinute,
  aiInstructions,
  fallbackTemplate,
}) {
  await ensureEmployeeBirthdaySettings();
  const res = await query(
    `UPDATE employee_birthday_settings
     SET timezone = $1,
         send_hour = $2,
         send_minute = $3,
         ai_instructions = $4,
         fallback_template = $5,
         updated_at = NOW()
     WHERE id = 1
     RETURNING *`,
    [timezone, sendHour, sendMinute, aiInstructions, fallbackTemplate]
  );
  return res.rows[0];
}

async function updateEmployeeBirthday(id, firstName, lastName, birthday) {
  const res = await query(
    `UPDATE employee_birthdays 
     SET first_name = $1, last_name = $2, birthday = $3 
     WHERE id = $4 RETURNING *`,
    [firstName, lastName, birthday, id]
  );
  return res.rows[0];
}

async function deleteEmployeeBirthday(id) {
  await query('DELETE FROM employee_birthdays WHERE id = $1', [id]);
}

async function createFacebookConnectSession({
  sessionToken,
  groupId,
  telegramGroupId,
  groupName,
  requestedByTelegramUserId,
  requestedByName,
  expiresAt,
}) {
  const res = await query(
    `INSERT INTO facebook_connect_sessions (
       session_token,
       group_id,
       telegram_group_id,
       group_name,
       requested_by_telegram_user_id,
       requested_by_name,
       expires_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      sessionToken,
      groupId,
      telegramGroupId,
      groupName || null,
      requestedByTelegramUserId || null,
      requestedByName || null,
      expiresAt,
    ]
  );
  return res.rows[0];
}

async function getFacebookConnectSessionByToken(sessionToken) {
  const res = await query(
    `SELECT *
       FROM facebook_connect_sessions
      WHERE session_token = $1
      LIMIT 1`,
    [sessionToken]
  );
  return res.rows[0] || null;
}

async function getFacebookConnectSessionByOAuthState(oauthState) {
  const res = await query(
    `SELECT *
       FROM facebook_connect_sessions
      WHERE oauth_state = $1
      LIMIT 1`,
    [oauthState]
  );
  return res.rows[0] || null;
}

async function updateFacebookConnectSessionOAuthState(sessionId, oauthState) {
  const res = await query(
    `UPDATE facebook_connect_sessions
        SET oauth_state = $1,
            updated_at = NOW(),
            last_error = NULL
      WHERE id = $2
      RETURNING *`,
    [oauthState, sessionId]
  );
  return res.rows[0] || null;
}

async function storeFacebookConnectSessionOAuthResult(sessionId, {
  oauthUserAccessTokenEncrypted,
  oauthUserId,
  oauthUserName,
}) {
  const res = await query(
    `UPDATE facebook_connect_sessions
        SET oauth_user_access_token_encrypted = $1,
            oauth_user_id = $2,
            oauth_user_name = $3,
            status = 'authorized',
            last_error = NULL,
            updated_at = NOW()
      WHERE id = $4
      RETURNING *`,
    [
      oauthUserAccessTokenEncrypted,
      oauthUserId || null,
      oauthUserName || null,
      sessionId,
    ]
  );
  return res.rows[0] || null;
}

async function markFacebookConnectSessionCompleted(sessionId) {
  const res = await query(
    `UPDATE facebook_connect_sessions
        SET status = 'completed',
            completed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [sessionId]
  );
  return res.rows[0] || null;
}

async function markFacebookConnectSessionError(sessionId, errorMessage) {
  const res = await query(
    `UPDATE facebook_connect_sessions
        SET status = CASE
              WHEN completed_at IS NOT NULL THEN status
              ELSE 'error'
            END,
            last_error = $1,
            updated_at = NOW()
      WHERE id = $2
      RETURNING *`,
    [errorMessage ? String(errorMessage).slice(0, 1000) : null, sessionId]
  );
  return res.rows[0] || null;
}

async function expireOldFacebookConnectSessions() {
  const res = await query(
    `UPDATE facebook_connect_sessions
        SET status = 'expired',
            updated_at = NOW()
      WHERE expires_at < NOW()
        AND status IN ('pending', 'authorized', 'error')`
  );
  return res.rowCount || 0;
}

async function upsertFacebookPageConnection({
  groupId,
  telegramGroupId,
  groupName,
  pageId,
  pageName,
  accessTokenEncrypted,
  tokenLast4,
  connectedByFacebookUserId,
  connectedByFacebookUserName,
  grantedTasks,
  grantedScopes,
  subscribedFields,
  lastSubscriptionStatus,
  lastError,
}) {
  const res = await query(
    `INSERT INTO facebook_page_connections (
       group_id,
       telegram_group_id,
       group_name,
       page_id,
       page_name,
       access_token_encrypted,
       token_last4,
       connected_by_facebook_user_id,
       connected_by_facebook_user_name,
       granted_tasks,
       granted_scopes,
       subscribed_fields,
       is_active,
       last_subscription_status,
       last_error,
       connected_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::text[], $12::text[], TRUE, $13, $14, NOW(), NOW())
     ON CONFLICT (page_id)
     DO UPDATE SET
       group_id = EXCLUDED.group_id,
       telegram_group_id = EXCLUDED.telegram_group_id,
       group_name = EXCLUDED.group_name,
       page_name = EXCLUDED.page_name,
       access_token_encrypted = EXCLUDED.access_token_encrypted,
       token_last4 = EXCLUDED.token_last4,
       connected_by_facebook_user_id = EXCLUDED.connected_by_facebook_user_id,
       connected_by_facebook_user_name = EXCLUDED.connected_by_facebook_user_name,
       granted_tasks = EXCLUDED.granted_tasks,
       granted_scopes = EXCLUDED.granted_scopes,
       subscribed_fields = EXCLUDED.subscribed_fields,
       is_active = TRUE,
       last_subscription_status = EXCLUDED.last_subscription_status,
       last_error = EXCLUDED.last_error,
       updated_at = NOW()
     RETURNING *`,
    [
      groupId,
      telegramGroupId,
      groupName || null,
      String(pageId),
      pageName,
      accessTokenEncrypted,
      tokenLast4 || null,
      connectedByFacebookUserId || null,
      connectedByFacebookUserName || null,
      Array.isArray(grantedTasks) ? grantedTasks : [],
      Array.isArray(grantedScopes) ? grantedScopes : [],
      Array.isArray(subscribedFields) ? subscribedFields : [],
      lastSubscriptionStatus || null,
      lastError || null,
    ]
  );
  return res.rows[0] || null;
}

async function getFacebookPageConnectionByPageId(pageId) {
  const res = await query(
    `SELECT *
       FROM facebook_page_connections
      WHERE page_id = $1
        AND is_active = TRUE
      LIMIT 1`,
    [String(pageId)]
  );
  return res.rows[0] || null;
}

async function getFacebookPageConnectionsByTelegramGroupId(telegramGroupId) {
  const res = await query(
    `SELECT *
       FROM facebook_page_connections
      WHERE telegram_group_id = $1
      ORDER BY page_name ASC`,
    [telegramGroupId]
  );
  return res.rows;
}

async function deactivateFacebookPageConnection(pageId) {
  const res = await query(
    `UPDATE facebook_page_connections
        SET is_active = FALSE,
            updated_at = NOW()
      WHERE page_id = $1
      RETURNING *`,
    [String(pageId)]
  );
  return res.rows[0] || null;
}

async function insertFacebookWebhookEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const inserted = [];
  for (const event of events) {
    const res = await query(
      `INSERT INTO facebook_webhook_events (
         event_key,
         page_id,
         event_type,
         payload
       )
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (event_key) DO NOTHING
       RETURNING *`,
      [
        event.eventKey,
        String(event.pageId),
        event.eventType,
        JSON.stringify(event.payload || {}),
      ]
    );
    if (res.rows[0]) inserted.push(res.rows[0]);
  }
  return inserted;
}

async function claimPendingFacebookWebhookEvents(limit = 10) {
  const res = await query(
    `WITH candidates AS (
       SELECT id
         FROM facebook_webhook_events
        WHERE status IN ('pending', 'failed')
          AND next_retry_at <= NOW()
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE facebook_webhook_events e
        SET status = 'processing',
            attempt_count = e.attempt_count + 1,
            updated_at = NOW()
       FROM candidates
      WHERE e.id = candidates.id
      RETURNING e.*`,
    [limit]
  );
  return res.rows;
}

async function completeFacebookWebhookEvent(eventId) {
  const res = await query(
    `UPDATE facebook_webhook_events
        SET status = 'completed',
            processed_at = NOW(),
            updated_at = NOW(),
            last_error = NULL
      WHERE id = $1
      RETURNING *`,
    [eventId]
  );
  return res.rows[0] || null;
}

async function failFacebookWebhookEvent(eventId, errorMessage, nextRetryAt) {
  const res = await query(
    `UPDATE facebook_webhook_events
        SET status = 'failed',
            last_error = $1,
            next_retry_at = $2,
            updated_at = NOW()
      WHERE id = $3
      RETURNING *`,
    [String(errorMessage || 'Unknown error').slice(0, 2000), nextRetryAt, eventId]
  );
  return res.rows[0] || null;
}

async function resetFacebookWebhookEventByIdentifier(identifier) {
  const normalized = String(identifier || '').trim();
  if (!normalized) return null;
  const res = await query(
    `UPDATE facebook_webhook_events
        SET status = 'pending',
            next_retry_at = NOW(),
            updated_at = NOW(),
            last_error = NULL
      WHERE id::text = $1
         OR event_key = $1
         OR event_key LIKE '%' || $1
      RETURNING *`,
    [normalized]
  );
  return res.rows[0] || null;
}

async function getRecentFacebookWebhookEvents(limit = 50) {
  const cappedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const res = await query(
    `SELECT *
       FROM facebook_webhook_events
      ORDER BY created_at DESC
      LIMIT $1`,
    [cappedLimit]
  );
  return res.rows;
}

async function recordFacebookSenderSeen(pageId, senderId, firstEventKey) {
  const res = await query(
    `INSERT INTO facebook_seen_senders (
       page_id,
       sender_id,
       first_event_key,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (page_id, sender_id) DO NOTHING
     RETURNING page_id, sender_id`,
    [String(pageId), String(senderId), firstEventKey || null]
  );
  return res.rows.length > 0;
}

async function hasFacebookSenderBeenSeen(pageId, senderId) {
  const res = await query(
    `SELECT 1
       FROM facebook_seen_senders
      WHERE page_id = $1
        AND sender_id = $2
      LIMIT 1`,
    [String(pageId), String(senderId)]
  );
  return res.rows.length > 0;
}

const DEFAULT_WORKING_HOURS_TEMPLATE = (
  'Hello {first_name}, this is {rep_name} with {company_name} '
  + 'and thanks for applying to our {position}. '
  + 'Can I call you right now to explain the details?'
);

const DEFAULT_FALLBACK_TEMPLATE = (
  'Hello {first_name}, this is {rep_name} with {company_name}. '
  + 'Thanks for applying to our {position}. '
  + 'When is a good time for me to call you and explain the details?'
);

async function seedFacebookLeadAutoMessageDefaults() {
  const existing = await query(
    'SELECT id FROM facebook_lead_auto_message_settings ORDER BY id LIMIT 1'
  );
  if (existing.rows.length > 0) return;

  const settingsRes = await query(
    `INSERT INTO facebook_lead_auto_message_settings (
       timezone,
       is_enabled,
       rep_name,
       company_name,
       position_label,
       fallback_template
     )
     VALUES ($1, TRUE, $2, $3, $4, $5)
     RETURNING id`,
    [
      'America/Chicago',
      'Tom',
      'Wenze trucking company',
      'OTR position',
      DEFAULT_FALLBACK_TEMPLATE,
    ]
  );
  const settingsId = settingsRes.rows[0].id;

  await query(
    `INSERT INTO facebook_lead_auto_message_rules (
       settings_id,
       label,
       days_of_week,
       start_time_local,
       end_time_local,
       message_template,
       sort_order,
       is_active
     )
     VALUES ($1, $2, $3, $4, $5, $6, 0, TRUE)`,
    [
      settingsId,
      'Working hours',
      [1, 2, 3, 4, 5],
      '08:00',
      '17:00',
      DEFAULT_WORKING_HOURS_TEMPLATE,
    ]
  );
  console.log('[DB] Seeded default Facebook lead auto-message settings.');
}

async function getFacebookLeadAutoMessageSettings() {
  const settingsRes = await query(
    `SELECT *
       FROM facebook_lead_auto_message_settings
      ORDER BY id
      LIMIT 1`
  );
  const settings = settingsRes.rows[0];
  if (!settings) return { settings: null, rules: [] };

  const rulesRes = await query(
    `SELECT *
       FROM facebook_lead_auto_message_rules
      WHERE settings_id = $1
      ORDER BY sort_order ASC, id ASC`,
    [settings.id]
  );
  return { settings, rules: rulesRes.rows };
}

async function replaceFacebookLeadAutoMessageConfig({ settings, rules }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let settingsId = settings.id;
    if (settingsId) {
      await client.query(
        `UPDATE facebook_lead_auto_message_settings
            SET timezone = $1,
                is_enabled = $2,
                rep_name = $3,
                company_name = $4,
                position_label = $5,
                fallback_template = $6,
                updated_at = NOW()
          WHERE id = $7`,
        [
          settings.timezone,
          settings.is_enabled,
          settings.rep_name,
          settings.company_name,
          settings.position_label,
          settings.fallback_template,
          settingsId,
        ]
      );
    } else {
      const insertRes = await client.query(
        `INSERT INTO facebook_lead_auto_message_settings (
           timezone,
           is_enabled,
           rep_name,
           company_name,
           position_label,
           fallback_template
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          settings.timezone,
          settings.is_enabled,
          settings.rep_name,
          settings.company_name,
          settings.position_label,
          settings.fallback_template,
        ]
      );
      settingsId = insertRes.rows[0].id;
    }

    await client.query(
      'DELETE FROM facebook_lead_auto_message_rules WHERE settings_id = $1',
      [settingsId]
    );

    const insertedRules = [];
    for (let i = 0; i < rules.length; i += 1) {
      const rule = rules[i];
      const res = await client.query(
        `INSERT INTO facebook_lead_auto_message_rules (
           settings_id,
           label,
           days_of_week,
           start_time_local,
           end_time_local,
           message_template,
           sort_order,
           is_active
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          settingsId,
          rule.label,
          rule.days_of_week,
          rule.start_time_local,
          rule.end_time_local,
          rule.message_template,
          rule.sort_order ?? i,
          rule.is_active !== false,
        ]
      );
      insertedRules.push(res.rows[0]);
    }

    const settingsRow = await client.query(
      'SELECT * FROM facebook_lead_auto_message_settings WHERE id = $1',
      [settingsId]
    );

    await client.query('COMMIT');
    return { settings: settingsRow.rows[0], rules: insertedRules };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listFacebookPageConnectionsAdmin() {
  const res = await query(
    `SELECT id,
            page_id,
            page_name,
            telegram_group_id,
            group_name,
            is_active,
            connected_at,
            updated_at,
            last_subscription_status,
            last_error
       FROM facebook_page_connections
      ORDER BY page_name ASC, id ASC`
  );
  return res.rows;
}

async function insertFacebookLeadSmsMirror({
  telegramChatId,
  telegramMessageId,
  driverPhone,
  smsBody,
  leadName = null,
  pageId = null,
  ruleLabel = null,
  ringcentralMessageId = null,
  sourceType = 'outbound_auto',
}) {
  const res = await query(
    `INSERT INTO facebook_lead_sms_mirrors (
       telegram_chat_id,
       telegram_message_id,
       driver_phone,
       sms_body,
       lead_name,
       page_id,
       rule_label,
       ringcentral_message_id,
       source_type
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (telegram_chat_id, telegram_message_id) DO UPDATE
       SET driver_phone = EXCLUDED.driver_phone,
           sms_body = EXCLUDED.sms_body,
           lead_name = EXCLUDED.lead_name,
           page_id = EXCLUDED.page_id,
           rule_label = EXCLUDED.rule_label,
           ringcentral_message_id = EXCLUDED.ringcentral_message_id,
           source_type = EXCLUDED.source_type
     RETURNING *`,
    [
      telegramChatId,
      telegramMessageId,
      driverPhone,
      smsBody,
      leadName,
      pageId,
      ruleLabel,
      ringcentralMessageId,
      sourceType,
    ]
  );
  return res.rows[0];
}

async function getFacebookLeadSmsMirror(telegramChatId, telegramMessageId) {
  const chatId = Number(telegramChatId);
  const messageId = Number(telegramMessageId);
  if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) return null;

  const res = await query(
    `SELECT *
       FROM facebook_lead_sms_mirrors
      WHERE telegram_chat_id = $1
        AND telegram_message_id = $2
      LIMIT 1`,
    [chatId, messageId]
  );
  return res.rows[0] || null;
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

// Simple DB liveness probe used by /api/health.
async function ping() {
  const res = await query('SELECT 1 AS ok');
  return res.rows[0]?.ok === 1;
}

module.exports = {
  pool,
  query,
  initializeDatabase,
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
  getDriverGroupsWithDispatchEtaSettings,
  getGroupByTelegramId,
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
  getDispatchEtaSettingByGroupId,
  upsertDispatchEtaSetting,
  getDispatchEtaGlobalSettings,
  setDispatchEtaGlobalIntervals,
  applyDispatchEtaIntervalsFromGlobals,
  claimDispatchEtaUpdateByGroupId,
  claimDueDispatchEtaUpdates,
  completeDispatchEtaUpdateSuccess,
  completeDispatchEtaUpdateFailure,
  // Drivers
  upsertDriver,
  getDriverByTelegramId,
  // Questions
  createQuestion,
  getActiveQuestions,
  getAllQuestions,
  getQuestionWithOptions,
  deactivateQuestion,
  // Responses
  saveResponse,
  getQuestionResponses,
  // Admins
  getAdminByUsername,
  createAdmin,
  // Scheduled Messages
  createScheduledMessage,
  getPendingScheduledMessages,
  getAllScheduledMessages,
  getScheduledMessageById,
  updateScheduledMessageStatus,
  recordRecurringScheduledMessageRun,
  claimScheduledMessage,
  deleteScheduledMessage,
  // Broadcast Tracking
  createBroadcast,
  createBroadcastDelivery,
  getBroadcasts,
  getBroadcastDeliveries,
  saveBroadcastButtonClick,
  getBroadcastButtonClicks,
  // Chat Logs
  logChatMessage,
  upsertGroupPinnedMessageSnapshot,
  getGroupPinnedMessageSnapshot,
  getGroupRecentLoads,
  hasGroupRecentLoadForMessage,
  hasAnyGroupRecentLoadForMessages,
  insertGroupRecentLoad,
  getChatLogsForGroup,
  getChatLogsForActiveDriverGroups,
  deleteOldChatLogs,
  getRecentChatLogs,
  // AI Reports
  saveAiReport,
  getPendingAiReports,
  getAiReportById,
  updateAiReportStatus,
  discardAiReport,
  // AI Insights v2
  refreshSenderRoleConsensus,
  getSenderRoleConsensus,
  getAnnotatedMessagesForRange,
  createAiInsight,
  getInsightsForReport,
  getInsightById,
  updateInsightStatus,
  deleteInsightsForReport,
  // Employee Birthdays
  upsertEmployeeBirthday,
  getAllEmployeeBirthdays,
  getEmployeesWithBirthdayOn,
  getEmployeesWithBirthdayToday,
  getEmployeeBirthdaysByIds,
  getEmployeeBirthdaySettings,
  updateEmployeeBirthdaySettings,
  ensureEmployeeBirthdaySettings,
  updateEmployeeBirthday,
  deleteEmployeeBirthday,
  // Facebook leads + connect
  createFacebookConnectSession,
  getFacebookConnectSessionByToken,
  getFacebookConnectSessionByOAuthState,
  updateFacebookConnectSessionOAuthState,
  storeFacebookConnectSessionOAuthResult,
  markFacebookConnectSessionCompleted,
  markFacebookConnectSessionError,
  expireOldFacebookConnectSessions,
  upsertFacebookPageConnection,
  getFacebookPageConnectionByPageId,
  getFacebookPageConnectionsByTelegramGroupId,
  deactivateFacebookPageConnection,
  insertFacebookWebhookEvents,
  claimPendingFacebookWebhookEvents,
  completeFacebookWebhookEvent,
  failFacebookWebhookEvent,
  resetFacebookWebhookEventByIdentifier,
  getRecentFacebookWebhookEvents,
  recordFacebookSenderSeen,
  hasFacebookSenderBeenSeen,
  getFacebookLeadAutoMessageSettings,
  replaceFacebookLeadAutoMessageConfig,
  listFacebookPageConnectionsAdmin,
  insertFacebookLeadSmsMirror,
  getFacebookLeadSmsMirror,
  // Service run guard + health
  claimServiceRun,
  ping,
};
