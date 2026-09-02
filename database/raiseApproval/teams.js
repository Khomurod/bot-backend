/**
 * Dispatch TEAMS — database helpers.
 *
 * The team is the unit a raise round is submitted for. Its people live in
 * ./teamMembers.js and its drivers in ./teamDrivers.js. Split out of
 * database/raiseApproval.js, which re-exports every symbol here.
 */
const { query } = require('../pool');

// ─── Dispatch teams ───

async function listDispatchTeams({ includeInactive = true } = {}) {
  const where = includeInactive ? '' : 'WHERE active = TRUE';
  const res = await query(
    `SELECT t.*,
            (SELECT COUNT(*) FROM dispatch_team_drivers d
              WHERE d.team_id = t.id AND d.active = TRUE)::int AS driver_count,
            (SELECT COUNT(*) FROM dispatch_team_members m
              WHERE m.team_id = t.id AND m.active = TRUE)::int AS member_count
     FROM dispatch_teams t ${where} ORDER BY t.name ASC, t.id ASC`
  );
  return res.rows;
}

async function getDispatchTeam(id) {
  const res = await query('SELECT * FROM dispatch_teams WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function createDispatchTeam(name) {
  const res = await query(
    'INSERT INTO dispatch_teams (name) VALUES ($1) RETURNING *',
    [name]
  );
  return res.rows[0];
}

async function updateDispatchTeam(id, { name, active } = {}) {
  const sets = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { sets.push(`name = $${i}`); values.push(name); i += 1; }
  if (active !== undefined) { sets.push(`active = $${i}`); values.push(active); i += 1; }
  if (!sets.length) return getDispatchTeam(id);
  sets.push('updated_at = NOW()');
  values.push(id);
  const res = await query(
    `UPDATE dispatch_teams SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function deleteDispatchTeam(id) {
  const res = await query('DELETE FROM dispatch_teams WHERE id = $1 RETURNING id', [id]);
  return res.rows.length > 0;
}

module.exports = {
  listDispatchTeams,
  getDispatchTeam,
  createDispatchTeam,
  updateDispatchTeam,
  deleteDispatchTeam,
};
