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
            (SELECT COUNT(*) FROM dispatch_team_drivers d WHERE d.team_id = t.id)::int AS driver_count
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

async function listTeamDrivers(teamId) {
  const res = await query(
    'SELECT * FROM dispatch_team_drivers WHERE team_id = $1 ORDER BY driver_name ASC',
    [teamId]
  );
  return res.rows;
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
