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
          driver_profile_id, group_id, unit_number, active, needs_review, person_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, FALSE,
               (SELECT person_id FROM driver_person_groups WHERE group_id = $6::int AND ended_at IS NULL LIMIT 1))
       ON CONFLICT (team_id, driver_normalized_name) DO UPDATE
         SET active = TRUE, needs_review = FALSE, driver_name = EXCLUDED.driver_name,
             driver_profile_id = EXCLUDED.driver_profile_id, group_id = EXCLUDED.group_id,
             unit_number = EXCLUDED.unit_number,
             person_id = COALESCE(EXCLUDED.person_id, dispatch_team_drivers.person_id),
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
            unit_number = COALESCE($4, unit_number), needs_review = FALSE, updated_at = NOW(),
            person_id = COALESCE(
              (SELECT person_id FROM driver_person_groups WHERE group_id = $3::int AND ended_at IS NULL LIMIT 1),
              person_id)
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

// ─── Reconciliation from the Dispatcher Board ───

/**
 * Today's roster, in the shape the plan reads.
 *
 * `assignment_source` is what lets reconciliation tell its own earlier work
 * from a decision a person made — see migration 0058.
 */
async function listRosterForReconciliation() {
  const res = await query(
    `SELECT id, team_id, driver_profile_id, group_id, person_id,
            driver_name, driver_normalized_name, assignment_source,
            manual_override_at, manual_override_by
       FROM dispatch_team_drivers
      WHERE active = TRUE`
  );
  return res.rows.map((r) => ({
    id: r.id,
    teamId: r.team_id,
    driverProfileId: r.driver_profile_id,
    groupId: r.group_id,
    personId: r.person_id,
    driverName: r.driver_name,
    driverNormalizedName: r.driver_normalized_name,
    assignmentSource: r.assignment_source || 'manual',
    manualOverrideAt: r.manual_override_at,
    manualOverrideBy: r.manual_override_by,
  }));
}

/**
 * Place a driver on the team the Board names, in one transaction.
 *
 * DELIBERATELY NOT `assignDriverToTeam`. That function is the admin path and
 * refuses a move unless the caller passes `force`, because a person doing it by
 * hand should be told they are taking a driver off somebody else's team.
 * Reconciliation IS the authority for a board-sourced row, so it moves the
 * driver and records what the Board said — but it still refuses to touch a row
 * a person marked manual, which is checked here as well as in the plan so the
 * guarantee does not depend on its caller.
 *
 * @returns `{ moved, fromTeamId }` — `moved: false` means nothing needed doing.
 */
async function applyBoardAssignment({
  teamId, personId = null, driverProfileId = null, groupId = null, unitNumber = null,
  driverName, driverNormalizedName, boardDispatcher = null, boardRowKey = null,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingRes = await client.query(
      `SELECT * FROM dispatch_team_drivers
        WHERE active = TRUE
          AND ( ($1::int IS NOT NULL AND person_id = $1)
             OR ($2::int IS NOT NULL AND driver_profile_id = $2)
             OR ($3::int IS NOT NULL AND group_id = $3) )
        FOR UPDATE`,
      [personId, driverProfileId, groupId]
    );
    const existing = existingRes.rows[0] || null;

    // THE SAME RULE AS `lib/raise/rosterPlan.js isHumanOverride`, enforced here
    // as well so the guarantee does not depend on the caller: a row is a
    // person's decision only when somebody actually made one, which
    // `markManualOverride` records as a timestamp. A row merely inherited from
    // before the Board could place anybody has no timestamp and is reconcilable.
    if (existing && existing.assignment_source === 'manual' && existing.manual_override_at != null) {
      await client.query('ROLLBACK');
      return { moved: false, heldByOverride: true, fromTeamId: existing.team_id };
    }
    if (existing && Number(existing.team_id) === Number(teamId)) {
      await client.query(
        `UPDATE dispatch_team_drivers
            SET board_dispatcher = $2, board_row_key = $3, reconciled_at = NOW(),
                review_reason = NULL, needs_review = FALSE, updated_at = NOW(),
                driver_name = COALESCE($4, driver_name),
                unit_number = COALESCE($5, unit_number),
                person_id = COALESCE($6, person_id)
          WHERE id = $1`,
        [existing.id, boardDispatcher, boardRowKey, driverName, unitNumber, personId]
      );
      await client.query('COMMIT');
      return { moved: false, fromTeamId: existing.team_id };
    }
    if (existing) {
      // A MOVE CLOSES THE OLD ROW RATHER THAN EDITING IT. The unique index
      // allows one active team per driver, and the closed row is the record
      // that they used to be somewhere else.
      await client.query(
        'UPDATE dispatch_team_drivers SET active = FALSE, updated_at = NOW() WHERE id = $1',
        [existing.id]
      );
    }

    const ins = await client.query(
      `INSERT INTO dispatch_team_drivers
         (team_id, driver_normalized_name, driver_name, driver_profile_id, group_id,
          unit_number, person_id, active, needs_review, assignment_source,
          board_dispatcher, board_row_key, reconciled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,FALSE,'board',$8,$9,NOW())
       ON CONFLICT (team_id, driver_normalized_name) DO UPDATE
         SET active = TRUE, needs_review = FALSE, review_reason = NULL,
             assignment_source = 'board',
             driver_name = EXCLUDED.driver_name,
             driver_profile_id = COALESCE(EXCLUDED.driver_profile_id, dispatch_team_drivers.driver_profile_id),
             group_id = COALESCE(EXCLUDED.group_id, dispatch_team_drivers.group_id),
             person_id = COALESCE(EXCLUDED.person_id, dispatch_team_drivers.person_id),
             unit_number = COALESCE(EXCLUDED.unit_number, dispatch_team_drivers.unit_number),
             board_dispatcher = EXCLUDED.board_dispatcher,
             board_row_key = EXCLUDED.board_row_key,
             reconciled_at = NOW(), updated_at = NOW()
       RETURNING id`,
      [teamId, driverNormalizedName, driverName, driverProfileId, groupId,
        unitNumber, personId, boardDispatcher, boardRowKey]
    );
    await client.query('COMMIT');
    return {
      moved: Boolean(existing), fromTeamId: existing ? existing.team_id : null, id: ins.rows[0]?.id,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Take a board-owned driver off the roster.
 *
 * Soft, and never for a row a person deliberately placed: a standing override
 * is somebody's decision and is not withdrawn because the Board stopped
 * mentioning them. A LEGACY row — typed before the Board could place anybody,
 * so carrying no override timestamp — IS withdrawable, because leaving it would
 * keep a driver on a team the Board no longer agrees with for ever. Nothing is
 * deleted, so a later question about the period is answerable.
 */
async function retireBoardAssignment(id) {
  const res = await query(
    `UPDATE dispatch_team_drivers
        SET active = FALSE, reconciled_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND active = TRUE
        AND NOT (assignment_source = 'manual' AND manual_override_at IS NOT NULL)
      RETURNING id`,
    [id]
  );
  return res.rows.length > 0;
}

/** Mark an assignment as a person's deliberate decision, with who and when. */
async function markManualOverride(id, by = null) {
  const res = await query(
    `UPDATE dispatch_team_drivers
        SET assignment_source = 'manual', manual_override_at = NOW(),
            manual_override_by = $2, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, by || null]
  );
  return res.rows[0] || null;
}

/** Hand a board-placed row back to the Board (retire a standing override). */
async function clearManualOverride(id) {
  const res = await query(
    `UPDATE dispatch_team_drivers
        SET assignment_source = 'board', manual_override_at = NULL,
            manual_override_by = NULL, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id]
  );
  return res.rows[0] || null;
}

/**
 * Replace the full driver assignment for a team (transactional).
 *
 * EVERY ROW IT WRITES IS STAMPED AS A HUMAN OVERRIDE, in the INSERT itself.
 * Reconciliation tells a person's decision from an inherited row by
 * `manual_override_at`, not by the word `manual` (see `applyBoardAssignment` and
 * `lib/raise/rosterPlan.js isHumanOverride`). This function used to rely on the
 * column DEFAULT, which supplies `assignment_source = 'manual'` and no
 * timestamp — so an administrator typing a roster here would have produced rows
 * the very next rebuild treated as legacy and reassigned from the Board,
 * silently undoing what they had just typed. The stamp goes in the same
 * statement as the row so there is no window in which an unstamped one exists.
 */
async function setTeamDrivers(teamId, drivers, { overriddenBy = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM dispatch_team_drivers WHERE team_id = $1', [teamId]);
    for (const d of drivers) {
      await client.query(
        `INSERT INTO dispatch_team_drivers
           (team_id, driver_external_id, driver_normalized_name, driver_name,
            assignment_source, manual_override_at, manual_override_by)
         VALUES ($1, $2, $3, $4, 'manual', NOW(), $5)
         ON CONFLICT (team_id, driver_normalized_name) DO NOTHING`,
        [teamId, d.driver_external_id || null, d.driver_normalized_name, d.driver_name,
          overriddenBy || null]
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
  listRosterForReconciliation,
  applyBoardAssignment,
  retireBoardAssignment,
  markManualOverride,
  clearManualOverride,
};
