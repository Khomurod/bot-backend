/**
 * Facebook self-serve /connect SESSIONS — database helpers.
 *
 * A short-lived, token-gated session that carries a leads group through the Meta
 * OAuth handshake. Split out of database/facebookLeads.js, which re-exports
 * every symbol here so existing importers are unchanged.
 */
const { query } = require('../pool');

async function createFacebookConnectSession({
  sessionToken,
  groupId,
  telegramGroupId,
  groupName,
  requestedByTelegramUserId,
  requestedByName,
  expiresAt,
}) {
  const res = await query(
    `INSERT INTO facebook_connect_sessions (
       session_token,
       group_id,
       telegram_group_id,
       group_name,
       requested_by_telegram_user_id,
       requested_by_name,
       expires_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      sessionToken,
      groupId,
      telegramGroupId,
      groupName || null,
      requestedByTelegramUserId || null,
      requestedByName || null,
      expiresAt,
    ]
  );
  return res.rows[0];
}

async function getFacebookConnectSessionByToken(sessionToken) {
  const res = await query(
    `SELECT *
       FROM facebook_connect_sessions
      WHERE session_token = $1
      LIMIT 1`,
    [sessionToken]
  );
  return res.rows[0] || null;
}

async function getFacebookConnectSessionByOAuthState(oauthState) {
  const res = await query(
    `SELECT *
       FROM facebook_connect_sessions
      WHERE oauth_state = $1
      LIMIT 1`,
    [oauthState]
  );
  return res.rows[0] || null;
}

async function updateFacebookConnectSessionOAuthState(sessionId, oauthState) {
  const res = await query(
    `UPDATE facebook_connect_sessions
        SET oauth_state = $1,
            updated_at = NOW(),
            last_error = NULL
      WHERE id = $2
      RETURNING *`,
    [oauthState, sessionId]
  );
  return res.rows[0] || null;
}

async function storeFacebookConnectSessionOAuthResult(sessionId, {
  oauthUserAccessTokenEncrypted,
  oauthUserId,
  oauthUserName,
}) {
  const res = await query(
    `UPDATE facebook_connect_sessions
        SET oauth_user_access_token_encrypted = $1,
            oauth_user_id = $2,
            oauth_user_name = $3,
            status = 'authorized',
            last_error = NULL,
            updated_at = NOW()
      WHERE id = $4
      RETURNING *`,
    [
      oauthUserAccessTokenEncrypted,
      oauthUserId || null,
      oauthUserName || null,
      sessionId,
    ]
  );
  return res.rows[0] || null;
}

async function markFacebookConnectSessionCompleted(sessionId) {
  const res = await query(
    `UPDATE facebook_connect_sessions
        SET status = 'completed',
            completed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [sessionId]
  );
  return res.rows[0] || null;
}

async function markFacebookConnectSessionError(sessionId, errorMessage) {
  const res = await query(
    `UPDATE facebook_connect_sessions
        SET status = CASE
              WHEN completed_at IS NOT NULL THEN status
              ELSE 'error'
            END,
            last_error = $1,
            updated_at = NOW()
      WHERE id = $2
      RETURNING *`,
    [errorMessage ? String(errorMessage).slice(0, 1000) : null, sessionId]
  );
  return res.rows[0] || null;
}

async function expireOldFacebookConnectSessions() {
  const res = await query(
    `UPDATE facebook_connect_sessions
        SET status = 'expired',
            updated_at = NOW()
      WHERE expires_at < NOW()
        AND status IN ('pending', 'authorized', 'error')`
  );
  return res.rowCount || 0;
}

module.exports = {
  createFacebookConnectSession,
  getFacebookConnectSessionByToken,
  getFacebookConnectSessionByOAuthState,
  updateFacebookConnectSessionOAuthState,
  storeFacebookConnectSessionOAuthResult,
  markFacebookConnectSessionCompleted,
  markFacebookConnectSessionError,
  expireOldFacebookConnectSessions,
};
