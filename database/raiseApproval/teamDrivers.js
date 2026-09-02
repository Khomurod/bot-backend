/**
 * Team DRIVER assignments — database helpers.
 *
 * Which company drivers a team is answerable for, including the transactional
 * reassignment that keeps a driver on at most one active team. Driver Groups is
 * the source of truth for identity; rows here link to a driver profile where one
 * is known and are flagged for review where it is not. Split out of
 * database/raiseApproval.js, which re-exports every symbol here.
 */
const { pool, query } = require('../pool');

async function listTeamDrivers(teamId, { activeOnly = true } = {}) {
  const where = activeOnly ? 'AND active = TRUE' : '';
  const res = await query(
    `SELECT * FROM dispatch_team_drivers WHERE team_id = $1 ${where} ORDER BY driver_name ASC`,
    [teamId]
  );
  return res.rows;
}

/** Every active assignment, with team name — used to annotate the candidate list. */
async function listActiveDriverAssignments() {
  const res = await query(
    `SELECT d.id, d.team_id, d.driver_profile_id, d.group_id, d.driver_normalized_name,
            d.driver_name, d.unit_number, d.needs_review, t.name AS team_name
       FROM dispatch_team_drivers d JOIN dispatch_teams t ON t.id = d.team_id
      WHERE d.active = TRUE`
  );
  return res.rows;
}

/** The active assignment for a given driver (by profile, then group, then normalized name). */
async function findActiveAssignmentForDriver({ driverProfileId = null, groupId = null, driverNormalizedName = null } = {}) {
  const lookups = [];
  if (driverProfileId) lookups.push(['d.driver_profile_id = $1', driverProfileId]);
  if (groupId) lookups.push(['d.group_id = $1', groupId]);
  if (driverNormalizedName) lookups.push(['d.driver_normalized_name = $1 AND d.driver_profile_id IS NULL AND d.group_id IS NULL', driverNormalizedName]);
  for (const [clause, value] of lookups) {
    const res = await query(
      `SELECT d.*, t.name AS team_name FROM dispatch_team_drivers d
         JOIN dispatch_teams t ON t.id = d.team_id
        WHERE d.active = TRUE AND ${clause} LIMIT 1`,
      [value]
    );
    if (res.rows[0]) return res.rows[0];
  }
  return null;
}

/**
 * Assign a driver to a team. A driver may be on only one active team at a time.
 * If already active on ANOTHER team: throws DRIVER_ON_OTHER_TEAM (with
 * conflictTeam) unless `force` is set, in which case the old assignment is
 * deactivated first (a deliberate reassignment). Idempotent for same-team.
 * @returns {{ assignment, moved, previousTeam, alreadyOnTeam }}
 */
async function assignDriverToTeam({
  teamId, driverProfileId = null, groupId = null, unitNumber = null,
  driverName, driverNormalizedName, driverExternalId = null, force = false,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingRes = await client.query(
      `SELECT d.*, t.name AS team_name FROM dispatch_team_drivers d
         JOIN dispatch_teams t ON t.id = d.team_id
        WHERE d.active = TRUE
          AND ( ($1::int IS NOT NULL AND d.driver_profile_id = $1)
             OR ($2::int IS NOT NULL AND d.group_id = $2)
             OR (d.driver_profile_id IS NULL AND d.group_id IS NULL AND d.driver_normalized_name = $3) )
        LIMIT 1`,
      [driverProfileId, groupId, driverNormalizedName]
    );
    const existing = existingRes.rows[0] || null;

    if (existing && existing.team_id === teamId) {
      // Refresh the snapshot/link but treat as a no-op assignment.
      const upd = await client.query(
        `UPDATE dispatch_team_drivers
            SET driver_name = $2, driver_profile_id = COALESCE($3, driver_profile_id),
                group_id = COALESCE($4, group_id), unit_number = COALESCE($5, unit_number),
                needs_review = FALSE, updated_at = NOW()
          WHERE id = $1 RETURNING *`,
        [existing.id, driverName, driverProfileId, groupId, unitNumber]
      );
      await client.query('COMMIT');
      return { assignment: upd.rows[0], moved: false, alreadyOnTeam: true, previousTeam: null };
    }

    if (existing && !force) {
      await client.query('ROLLBACK');
      const err = new Error(`This driver is already assigned to ${existing.team_name}.`);
      err.code = 'DRIVER_ON_OTHER_TEAM';
      err.status = 409;
      err.conflictTeam = { id: existing.team_id, name: existing.team_name };
      throw err;
    }
    if (existing && force) {
      await client.query(
        'UPDATE dispatch_team_drivers SET active = FALSE, updated_at = NOW() WHERE id = $1',
        [existing.id]
      );
    }

    const ins = await client.query(
      `INSERT INTO dispatch_team_drivers
         (team_id, driver_external_id, driver_normalized_name, driver_name,
          driver_profile_id, group_id, unit_number, active, needs_review)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, FALSE)
       ON CONFLICT (team_id, driver_normalized_name) DO UPDATE
         SET active = TRUE, needs_review = FALSE, driver_name = EXCLUDED.driver_name,
             driver_profile_id = EXCLUDED.driver_profile_id, group_id = EXCLUDED.group_id,
             unit_number = EXCLUDED.unit_number,
             driver_external_id = COALESCE(EXCLUDED.driver_external_id, dispatch_team_drivers.driver_external_id),
             updated_at = NOW()
       RETURNING *`,
      [teamId, driverExternalId, driverNormalizedName, driverName, driverProfileId, groupId, unitNumber]
    );
    await client.query('COMMIT');
    return {
      assignment: ins.rows[0],
      moved: Boolean(existing && force),
      previousTeam: existing ? { id: existing.team_id, name: existing.team_name } : null,
      alreadyOnTeam: false,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Remove a single driver assignment (hard delete; raise history is snapshotted in picks). */
async function removeTeamDriver(id) {
  const res = await query('DELETE FROM dispatch_team_drivers WHERE id = $1 RETURNING id', [id]);
  return res.rows.length > 0;
}

// ─── Legacy backfill: link name-only rows to driver profiles ───

/** Active assignments not yet linked to a driver profile (legacy Datatruck rows). */
async function listUnlinkedTeamDrivers() {
  const res = await query(
    'SELECT * FROM dispatch_team_drivers WHERE active = TRUE AND driver_profile_id IS NULL'
  );
  return res.rows;
}

async function linkTeamDriverToProfile(id, { driverProfileId, groupId, unitNumber }) {
  const res = await query(
    `UPDATE dispatch_team_drivers
        SET driver_profile_id = $2, group_id = $3,
            unit_number = COALESCE($4, unit_number), needs_review = FALSE, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, driverProfileId || null, groupId || null, unitNumber || null]
  );
  return res.rows[0] || null;
}

async function markTeamDriverNeedsReview(id, needsReview = true) {
  const res = await query(
    'UPDATE dispatch_team_drivers SET needs_review = $2, updated_at = NOW() WHERE id = $1 RETURNING *',
    [id, Boolean(needsReview)]
  );
  return res.rows[0] || null;
}

/** Replace the full driver assignment for a team (transactional). */
async function setTeamDrivers(teamId, drivers) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM dispatch_team_drivers WHERE team_id = $1', [teamId]);
    for (const d of drivers) {
      await client.query(
        `INSERT INTO dispatch_team_drivers
           (team_id, driver_external_id, driver_normalized_name, driver_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (team_id, driver_normalized_name) DO NOTHING`,
        [teamId, d.driver_external_id || null, d.driver_normalized_name, d.driver_name]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return listTeamDrivers(teamId);
}

module.exports = {
  listTeamDrivers,
  listActiveDriverAssignments,
  findActiveAssignmentForDriver,
  assignDriverToTeam,
  removeTeamDriver,
  listUnlinkedTeamDrivers,
  linkTeamDriverToProfile,
  markTeamDriverNeedsReview,
  setTeamDrivers,
};
