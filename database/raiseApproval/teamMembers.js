/**
 * Dispatch team MEMBERS (the people) — database helpers.
 *
 * Dispatchers on a team, and the lookups that map an incoming Telegram username
 * or user id back to the teams they may submit for — the authorization edge of
 * the raise flow. Split out of database/raiseApproval.js, which re-exports
 * every symbol here.
 */
const { query } = require('../pool');

// ─── Dispatch team members (dispatchers) ───

async function listTeamMembers(teamId, { activeOnly = false } = {}) {
  const where = activeOnly ? 'AND active = TRUE' : '';
  const res = await query(
    `SELECT * FROM dispatch_team_members WHERE team_id = $1 ${where}
     ORDER BY active DESC, name ASC NULLS LAST, telegram_username ASC NULLS LAST, id ASC`,
    [teamId]
  );
  return res.rows;
}

async function createTeamMember(teamId, {
  name = null, telegramUsername = null, telegramUserId = null, role = null, active = true,
} = {}) {
  const res = await query(
    `INSERT INTO dispatch_team_members (team_id, name, telegram_username, telegram_user_id, role, active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [teamId, name || null, telegramUsername || null, telegramUserId || null, role || null, active !== false]
  );
  return res.rows[0];
}

async function updateTeamMember(id, patch = {}) {
  const map = {
    name: 'name',
    telegramUsername: 'telegram_username',
    telegramUserId: 'telegram_user_id',
    role: 'role',
    active: 'active',
  };
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, col] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      sets.push(`${col} = $${i}`);
      values.push(patch[key]);
      i += 1;
    }
  }
  if (!sets.length) {
    const res = await query('SELECT * FROM dispatch_team_members WHERE id = $1', [id]);
    return res.rows[0] || null;
  }
  sets.push('updated_at = NOW()');
  values.push(id);
  const res = await query(
    `UPDATE dispatch_team_members SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function deleteTeamMember(id) {
  const res = await query('DELETE FROM dispatch_team_members WHERE id = $1 RETURNING id', [id]);
  return res.rows.length > 0;
}

/** Active members (of active teams) whose Telegram username matches (already normalized, lowercased, no @). */
async function findActiveTeamMembersByUsername(normalizedUsername) {
  if (!normalizedUsername) return [];
  const res = await query(
    `SELECT m.*, t.name AS team_name FROM dispatch_team_members m
       JOIN dispatch_teams t ON t.id = m.team_id
      WHERE m.active = TRUE AND t.active = TRUE
        AND m.telegram_username IS NOT NULL
        AND lower(m.telegram_username) = $1`,
    [normalizedUsername]
  );
  return res.rows;
}

/** Active members (of active teams) whose numeric Telegram id matches. */
async function findActiveTeamMembersByUserId(telegramUserId) {
  if (telegramUserId == null) return [];
  const res = await query(
    `SELECT m.*, t.name AS team_name FROM dispatch_team_members m
       JOIN dispatch_teams t ON t.id = m.team_id
      WHERE m.active = TRUE AND t.active = TRUE AND m.telegram_user_id = $1`,
    [telegramUserId]
  );
  return res.rows;
}

// ─── Team ↔ driver assignments (Driver Groups source of truth) ───

/** Active team ids responsible for a driver group (via its assigned driver). */
async function getActiveTeamIdsForGroup(groupId) {
  if (!groupId) return [];
  const res = await query(
    'SELECT DISTINCT team_id FROM dispatch_team_drivers WHERE active = TRUE AND group_id = $1',
    [groupId]
  );
  return res.rows.map((r) => r.team_id);
}

module.exports = {
  listTeamMembers,
  createTeamMember,
  updateTeamMember,
  deleteTeamMember,
  findActiveTeamMembersByUsername,
  findActiveTeamMembersByUserId,
  getActiveTeamIdsForGroup,
};
