/**
 * Raise ROUNDS and submissions — database helpers.
 *
 * A weekly round carries a tokenized public link; each team submits once, and
 * the submission plus its per-driver picks are written in ONE transaction so a
 * partial submission can never be read as complete. Split out of
 * database/raiseApproval.js, which re-exports every symbol here.
 */
const { pool, query } = require('../pool');

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

module.exports = {
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
};
