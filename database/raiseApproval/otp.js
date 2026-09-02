/**
 * Dispatcher one-time passcodes — database helpers.
 *
 * Verifies a dispatcher before they may submit for a team. Attempt counting and
 * the recent-send count are the rate-limit inputs, so they are read and written
 * here rather than inferred anywhere else. Split out of
 * database/raiseApproval.js, which re-exports every symbol here.
 */
const { query } = require('../pool');

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
  createOtp,
  getLatestOtp,
  incrementOtpAttempts,
  markOtpVerified,
  isContactVerified,
  countRecentOtps,
};
