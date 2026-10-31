/**
 * Telegram groups: registration, activation state, language/birthday fields,
 * lookups by id/type/name, and the broadcast-target getters.
 * Extracted verbatim from database/db.js; db.js re-exports these so every
 * existing `require('./db')` caller keeps working.
 */
const { query } = require('./pool');
const { cachedGroupRow, rememberGroupRow, forgetGroupRows } = require('./groupRowCache');

/**
 * Register a chat seen in a message, or refresh its name. Runs on EVERY group
 * message, so a chat whose row was read in the last few minutes under the same
 * name is answered from database/groupRowCache.js — the write would change
 * nothing and the row it echoes is already known.
 */
async function upsertGroup(telegramGroupId, groupName) {
  const cached = cachedGroupRow(telegramGroupId);
  if (cached && cached.group_name === groupName) return cached;
  // `previous_group_name` is the title BEFORE this write — so a rename is seen
  // (services/driverGroupTitleSync.js). NULL for a chat seen the first time.
  const res = await query(
    `WITH before AS (SELECT group_name FROM groups WHERE telegram_group_id = $1)
     INSERT INTO groups (telegram_group_id, group_name, active, status_source)
     VALUES ($1, $2, TRUE, 'bot')
     ON CONFLICT (telegram_group_id)
     DO UPDATE SET group_name = EXCLUDED.group_name
     RETURNING *, (SELECT group_name FROM before) AS previous_group_name`,
    [telegramGroupId, groupName]
  );
  console.log(`[DB] Group upserted: ${groupName} (${telegramGroupId})`);
  if (res.rows[0]) {
    // The cache keeps the row WITHOUT the previous title: a cached answer must
    // never look like a rename again on the next message.
    const { previous_group_name: _previous, ...row } = res.rows[0];
    rememberGroupRow(row);
  }
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
  forgetGroupRows();
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
  forgetGroupRows();
  return res.rows[0];
}

/** Driver groups eligible for AI status classification (excludes manual locks). */
async function getDriverGroupsForStatusAi() {
  const res = await query(
    `SELECT g.id, g.group_name, g.active, g.status_source,
            -- The activity signals a deactivation is checked against. A model
            -- reading a chat TITLE cannot see any of these, and every one of
            -- them is already recorded, so asking costs one join apiece.
            g.last_message_seen_at,
            s.last_status_at              AS home_status_at,
            EXISTS (SELECT 1 FROM driver_road_history h
                     WHERE h.group_id = g.id AND h.return_to_road_at IS NULL) AS open_home_cycle,
            (SELECT MAX(h.home_arrived_at) FROM driver_road_history h
              WHERE h.group_id = g.id)    AS last_road_history_at,
            (SELECT MAX(u.started_at) FROM driver_units u
               JOIN driver_person_groups pg ON pg.person_id = u.person_id AND pg.ended_at IS NULL
              WHERE pg.group_id = g.id AND u.ended_at IS NULL) AS open_unit_at
       FROM groups g
       LEFT JOIN driver_home_status s ON s.group_id = g.id
      WHERE g.group_type = 'driver'
        AND (g.status_source IS NULL OR g.status_source IS DISTINCT FROM 'manual')
      ORDER BY g.id`
  );
  return res.rows;
}

async function getAllGroups() {
  const res = await query("SELECT * FROM groups WHERE group_type = 'driver' AND active = TRUE ORDER BY id");
  return res.rows;
}

/**
 * The active driver groups as id and title only — what a pass that matches a
 * unit number to its group needs, without every column of every group (load
 * control reads this every ten minutes).
 */
async function listActiveDriverGroupNames() {
  const res = await query(
    "SELECT id, group_name FROM groups WHERE group_type = 'driver' AND active = TRUE ORDER BY id"
  );
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

/**
 * Driver groups with the driver TYPE somebody recorded on their profile.
 *
 * A separate query rather than widening `getAllDriverGroups`, which the ETA
 * scheduler shares and which has no use for a profile column. The join is LEFT:
 * a group with no profile row still appears, with a null type, and the caller
 * falls back to the title.
 */
async function getDriverGroupsWithDriverType(filter) {
  const f = filter === 'all' || filter === 'inactive' ? filter : 'active';
  let activeClause = '';
  if (f === 'active') activeClause = ' AND g.active = TRUE';
  else if (f === 'inactive') activeClause = ' AND g.active = FALSE';
  const res = await query(
    `SELECT g.*, dp.driver_type, dp.driver_type_source
       FROM groups g
       LEFT JOIN driver_profiles dp ON dp.group_id = g.id
      WHERE g.group_type = 'driver'${activeClause}
      ORDER BY g.id`
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
  forgetGroupRows();
  console.log(`[DB] Group deactivated: ${telegramGroupId}`);
}

async function getGroupByTelegramId(telegramGroupId) {
  // The message handler asks for the row the registration middleware has just
  // read; database/groupRowCache.js answers that without a second trip.
  const cached = cachedGroupRow(telegramGroupId);
  if (cached) return cached;
  const res = await query(
    'SELECT * FROM groups WHERE telegram_group_id = $1',
    [telegramGroupId]
  );
  if (res.rows[0]) rememberGroupRow(res.rows[0]);
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

async function updateGroupSamsaraId(groupId, samsaraId) {
  const normalized = samsaraId ? String(samsaraId).trim() : null;
  const res = await query(
    `UPDATE groups
     SET samsara_vehicle_id = $1
     WHERE id = $2
     RETURNING *`,
    [normalized || null, groupId]
  );
  forgetGroupRows();
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
  getDriverGroupsForStatusAi,
  getAllGroups,
  getDriverGroupsByActiveFilter,
  listActiveDriverGroupNames,
  getDriverGroupsWithDriverType,
  getGroupsByIdsForAdmin,
  getDriverGroupsByLanguagesAndActiveFilter,
  deactivateGroup,
  getGroupByTelegramId,
  getGroupsByType,
  getOtherCompanyGroups,
  searchGroupsByName,
  getGroupByIdAnyType,
  getGroupBySamsaraId,
  updateGroupSamsaraId,
  getGroupsWithBirthdayToday,
  getAllDriverGroups,
  getGroupsByIds,
  getGroupsByLanguages,
};
