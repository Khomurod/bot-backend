/**
 * RINGCENTRAL CONNECT SESSIONS — database helpers.
 *
 * A short-lived, single-use link an admin hands to a recruiter so the recruiter
 * can authorize RingCentral for their own number
 * (`GET /ringcentral/connect/:token`). The token in the URL IS the credential —
 * these routes carry no admin session — so it expires, it is consumed on
 * success, and every step re-validates it. Modeled on
 * `facebook_connect_sessions`, which solved the same problem for Meta Pages.
 *
 * `oauth_state` is the CSRF binding between the redirect we sent and the
 * callback we get back: it is unique, written just before the redirect, and the
 * only way to find the session again on the way in.
 *
 * Split out of database/ringcentral.js, which re-exports every symbol here.
 */
const { query } = require('../pool');

const ALLOWED_STATUSES = new Set(['pending', 'completed', 'expired', 'error']);

async function createRcConnectSession({
  sessionToken,
  recruiterId = null,
  invitedName = null,
  createdBy = null,
  expiresAt,
}) {
  const token = String(sessionToken || '').trim();
  if (!token) throw new Error('A session token is required.');
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
    throw new Error('A valid expiry is required.');
  }
  const res = await query(
    `INSERT INTO ringcentral_connect_sessions
       (session_token, recruiter_id, invited_name, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      token,
      recruiterId ?? null,
      invitedName ? String(invitedName).trim().slice(0, 200) : null,
      createdBy ? String(createdBy).slice(0, 200) : null,
      expiresAt,
    ]
  );
  return res.rows[0];
}

async function getRcConnectSessionByToken(sessionToken) {
  const token = String(sessionToken || '').trim();
  if (!token) return null;
  const res = await query(
    'SELECT * FROM ringcentral_connect_sessions WHERE session_token = $1',
    [token]
  );
  return res.rows[0] || null;
}

async function getRcConnectSessionByOAuthState(state) {
  const value = String(state || '').trim();
  if (!value) return null;
  const res = await query(
    'SELECT * FROM ringcentral_connect_sessions WHERE oauth_state = $1',
    [value]
  );
  return res.rows[0] || null;
}

async function setRcConnectSessionOAuthState(id, state) {
  await query(
    `UPDATE ringcentral_connect_sessions
        SET oauth_state = $2, updated_at = NOW()
      WHERE id = $1`,
    [id, String(state || '').trim() || null]
  );
}

/** Consume the link. A completed session can never be replayed. */
async function completeRcConnectSession(id, recruiterId) {
  const res = await query(
    `UPDATE ringcentral_connect_sessions
        SET status = 'completed',
            recruiter_id = COALESCE($2, recruiter_id),
            last_error = NULL,
            completed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, recruiterId ?? null]
  );
  return res.rows[0] || null;
}

/**
 * Record a failure WITHOUT consuming the link: a recruiter who cancelled the
 * RingCentral prompt, or hit a transient error, can just open it again.
 */
async function markRcConnectSessionError(id, message) {
  await query(
    `UPDATE ringcentral_connect_sessions
        SET last_error = $2, updated_at = NOW()
      WHERE id = $1`,
    [id, message ? String(message).slice(0, 500) : null]
  );
}

async function expireOldRcConnectSessions() {
  await query(
    `UPDATE ringcentral_connect_sessions
        SET status = 'expired', updated_at = NOW()
      WHERE status = 'pending' AND expires_at < NOW()`
  );
}

module.exports = {
  ALLOWED_STATUSES,
  createRcConnectSession,
  getRcConnectSessionByToken,
  getRcConnectSessionByOAuthState,
  setRcConnectSessionOAuthState,
  completeRcConnectSession,
  markRcConnectSessionError,
  expireOldRcConnectSessions,
};
