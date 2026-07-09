/**
 * Telegram groups: registration, activation state, language/birthday fields,
 * lookups by id/type/name, and the broadcast-target getters.
 * Extracted verbatim from database/db.js; db.js re-exports these so every
 * existing `require('./db')` caller keeps working.
 */
const { query } = require('./pool');

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


module.exports = {
  upsertGroup,
  reactivateGroupOnBotJoin,
  updateGroupOperationalStatus,
  setGroupStatusByAdmin,
  getDriverGroupsForStatusAi,
  getAllGroups,
  getDriverGroupsByActiveFilter,
  getGroupsByIdsForAdmin,
  getDriverGroupsByLanguagesAndActiveFilter,
  deactivateGroup,
  getGroupByTelegramId,
  getGroupsByType,
  getOtherCompanyGroups,
  searchGroupsByName,
  getGroupByIdAnyType,
  getGroupBySamsaraId,
  setGroupLanguage,
  setGroupBirthday,
  updateGroupSamsaraId,
  getGroupsWithBirthdayToday,
  getAllDriverGroups,
  getGroupsByIds,
  getGroupsByLanguages,
};
