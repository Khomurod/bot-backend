/**
 * 75¢/mile Driver Raise Approval — database helpers.
 *
 * Isolated from the milestone "mileage bonus" feature. Backs the dispatch-team
 * weekly approval flow: teams + their company drivers, a settings row, approval
 * rounds (with a tokenized public link), per-team submissions/picks, and the
 * one-time passcodes used to verify a dispatcher before they submit.
 */
const { pool, query } = require('./db');

// ─── Settings (single row, id = 1) ───

async function getRaiseSettings() {
  const res = await query('SELECT * FROM raise_settings WHERE id = 1');
  return res.rows[0] || null;
}

const SETTINGS_COLUMNS = [
  'enabled', 'otp_channel', 'schedule_enabled', 'weekly_day_of_week',
  'weekly_time_local', 'schedule_timezone', 'rate_low', 'rate_high',
  'link_ttl_hours', 'next_run_at', 'gmail_user', 'gmail_app_password_encrypted',
];

async function updateRaiseSettings(patch = {}) {
  const sets = [];
  const values = [];
  let i = 1;
  for (const col of SETTINGS_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(patch, col)) {
      sets.push(`${col} = $${i}`);
      values.push(patch[col]);
      i += 1;
    }
  }
  if (!sets.length) return getRaiseSettings();
  sets.push('updated_at = NOW()');
  const res = await query(
    `UPDATE raise_settings SET ${sets.join(', ')} WHERE id = 1 RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

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

async function listTeamDrivers(teamId, { activeOnly = true } = {}) {
  const where = activeOnly ? 'AND active = TRUE' : '';
  const res = await query(
    `SELECT * FROM dispatch_team_drivers WHERE team_id = $1 ${where} ORDER BY driver_name ASC`,
    [teamId]
  );
  return res.rows;
}

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

// ─── Rounds ───

async function getOpenRound() {
  const res = await query(
    `SELECT * FROM raise_rounds WHERE status = 'open' AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`
  );
  return res.rows[0] || null;
}

async function createRound({
  periodStart, periodEnd, accessToken, expiresAt, rateLow, rateHigh, createdBy,
}) {
  const res = await query(
    `INSERT INTO raise_rounds
       (period_start, period_end, access_token, expires_at, rate_low, rate_high, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [periodStart, periodEnd, accessToken, expiresAt, rateLow, rateHigh, createdBy || null]
  );
  return res.rows[0];
}

async function getRoundByToken(token) {
  const res = await query('SELECT * FROM raise_rounds WHERE access_token = $1', [token]);
  return res.rows[0] || null;
}

async function getRoundById(id) {
  const res = await query('SELECT * FROM raise_rounds WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function setRoundEmployeeMessage(id, chatId, messageId) {
  await query(
    'UPDATE raise_rounds SET employee_chat_id = $1, employee_message_id = $2 WHERE id = $3',
    [chatId != null ? String(chatId) : null, messageId || null, id]
  );
}

async function listRounds({ limit = 50 } = {}) {
  const res = await query(
    `SELECT r.*,
            (SELECT COUNT(*) FROM raise_round_submissions s WHERE s.round_id = r.id)::int AS submission_count
     FROM raise_rounds r ORDER BY r.created_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows;
}

async function closeRound(id) {
  const res = await query(
    `UPDATE raise_rounds SET status = 'closed', closed_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id]
  );
  return res.rows[0] || null;
}

async function getSubmissionForTeam(roundId, teamId) {
  const res = await query(
    'SELECT * FROM raise_round_submissions WHERE round_id = $1 AND team_id = $2',
    [roundId, teamId]
  );
  return res.rows[0] || null;
}

/** IDs of the teams that have already submitted a response for this round. */
async function listSubmittedTeamIds(roundId) {
  const res = await query(
    'SELECT team_id FROM raise_round_submissions WHERE round_id = $1',
    [roundId]
  );
  return res.rows.map((r) => r.team_id);
}

/**
 * Save a team's one-and-only submission for a round, plus its per-driver picks.
 * A team may submit at most once per round: if a submission already exists for
 * (round_id, team_id), the insert is skipped and `null` is returned so the
 * caller can refuse the request instead of overwriting the original response.
 */
async function saveSubmissionWithPicks({
  roundId, teamId, dispatcherName, dispatcherContact, contactType, picks,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const subRes = await client.query(
      `INSERT INTO raise_round_submissions
         (round_id, team_id, dispatcher_name, dispatcher_contact, contact_type)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (round_id, team_id) DO NOTHING
       RETURNING *`,
      [roundId, teamId, dispatcherName, dispatcherContact, contactType]
    );
    const submission = subRes.rows[0];
    if (!submission) {
      await client.query('ROLLBACK');
      return null;
    }
    for (const p of picks) {
      await client.query(
        `INSERT INTO raise_round_picks
           (submission_id, round_id, team_id, driver_normalized_name, driver_name, qualified)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [submission.id, roundId, teamId, p.driver_normalized_name, p.driver_name, Boolean(p.qualified)]
      );
    }
    await client.query('COMMIT');
    return submission;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Full results for a round: submissions with their team name and picks. */
async function getRoundResults(roundId) {
  const subs = await query(
    `SELECT s.*, t.name AS team_name
     FROM raise_round_submissions s
     JOIN dispatch_teams t ON t.id = s.team_id
     WHERE s.round_id = $1 ORDER BY t.name ASC`,
    [roundId]
  );
  const picks = await query(
    `SELECT * FROM raise_round_picks WHERE round_id = $1 ORDER BY driver_name ASC`,
    [roundId]
  );
  const picksBySubmission = new Map();
  for (const p of picks.rows) {
    if (!picksBySubmission.has(p.submission_id)) picksBySubmission.set(p.submission_id, []);
    picksBySubmission.get(p.submission_id).push(p);
  }
  return subs.rows.map((s) => ({ ...s, picks: picksBySubmission.get(s.id) || [] }));
}

// ─── One-time passcodes ───

async function createOtp({
  roundId, teamId, contact, contactType, codeHash, expiresAt,
}) {
  const res = await query(
    `INSERT INTO raise_otp (round_id, team_id, contact, contact_type, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [roundId, teamId || null, contact, contactType, codeHash, expiresAt]
  );
  return res.rows[0];
}

async function getLatestOtp(roundId, contact) {
  const res = await query(
    `SELECT * FROM raise_otp WHERE round_id = $1 AND contact = $2
     ORDER BY created_at DESC LIMIT 1`,
    [roundId, contact]
  );
  return res.rows[0] || null;
}

async function incrementOtpAttempts(id) {
  const res = await query(
    'UPDATE raise_otp SET attempts = attempts + 1 WHERE id = $1 RETURNING *',
    [id]
  );
  return res.rows[0] || null;
}

async function markOtpVerified(id) {
  const res = await query(
    'UPDATE raise_otp SET verified = TRUE, verified_at = NOW() WHERE id = $1 RETURNING *',
    [id]
  );
  return res.rows[0] || null;
}

/** True if `contact` has a verified, unexpired passcode for this round. */
async function isContactVerified(roundId, contact) {
  const res = await query(
    `SELECT 1 FROM raise_otp
     WHERE round_id = $1 AND contact = $2 AND verified = TRUE AND expires_at > NOW()
     LIMIT 1`,
    [roundId, contact]
  );
  return res.rows.length > 0;
}

// How many passcodes were requested for a contact in the last N minutes
// (cheap rate-limit signal for the public request-otp endpoint).
async function countRecentOtps(roundId, contact, minutes) {
  const res = await query(
    `SELECT COUNT(*)::int AS n FROM raise_otp
     WHERE round_id = $1 AND contact = $2 AND created_at > NOW() - ($3 || ' minutes')::interval`,
    [roundId, contact, String(minutes)]
  );
  return res.rows[0]?.n || 0;
}

module.exports = {
  getRaiseSettings,
  updateRaiseSettings,
  listDispatchTeams,
  getDispatchTeam,
  createDispatchTeam,
  updateDispatchTeam,
  deleteDispatchTeam,
  listTeamDrivers,
  setTeamDrivers,
  listTeamMembers,
  createTeamMember,
  updateTeamMember,
  deleteTeamMember,
  findActiveTeamMembersByUsername,
  findActiveTeamMembersByUserId,
  getActiveTeamIdsForGroup,
  listActiveDriverAssignments,
  findActiveAssignmentForDriver,
  assignDriverToTeam,
  removeTeamDriver,
  listUnlinkedTeamDrivers,
  linkTeamDriverToProfile,
  markTeamDriverNeedsReview,
  getOpenRound,
  createRound,
  getRoundByToken,
  getRoundById,
  setRoundEmployeeMessage,
  listRounds,
  closeRound,
  getSubmissionForTeam,
  listSubmittedTeamIds,
  saveSubmissionWithPicks,
  getRoundResults,
  createOtp,
  getLatestOtp,
  incrementOtpAttempts,
  markOtpVerified,
  isContactVerified,
  countRecentOtps,
};
