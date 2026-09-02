/**
 * Connected Facebook PAGES — database helpers.
 *
 * One row per Page a leads group is wired to, holding the ENCRYPTED Page access
 * token (services/facebookCrypto.js owns the cipher). Split out of
 * database/facebookLeads.js, which re-exports every symbol here.
 */
const { pool, query } = require('../pool');

async function upsertFacebookPageConnection({
  groupId,
  telegramGroupId,
  groupName,
  pageId,
  pageName,
  accessTokenEncrypted,
  tokenLast4,
  connectedByFacebookUserId,
  connectedByFacebookUserName,
  grantedTasks,
  grantedScopes,
  subscribedFields,
  lastSubscriptionStatus,
  lastError,
}) {
  const res = await query(
    `INSERT INTO facebook_page_connections (
       group_id,
       telegram_group_id,
       group_name,
       page_id,
       page_name,
       access_token_encrypted,
       token_last4,
       connected_by_facebook_user_id,
       connected_by_facebook_user_name,
       granted_tasks,
       granted_scopes,
       subscribed_fields,
       is_active,
       last_subscription_status,
       last_error,
       connected_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11::text[], $12::text[], TRUE, $13, $14, NOW(), NOW())
     ON CONFLICT (page_id)
     DO UPDATE SET
       group_id = EXCLUDED.group_id,
       telegram_group_id = EXCLUDED.telegram_group_id,
       group_name = EXCLUDED.group_name,
       page_name = EXCLUDED.page_name,
       access_token_encrypted = EXCLUDED.access_token_encrypted,
       token_last4 = EXCLUDED.token_last4,
       connected_by_facebook_user_id = EXCLUDED.connected_by_facebook_user_id,
       connected_by_facebook_user_name = EXCLUDED.connected_by_facebook_user_name,
       granted_tasks = EXCLUDED.granted_tasks,
       granted_scopes = EXCLUDED.granted_scopes,
       subscribed_fields = EXCLUDED.subscribed_fields,
       is_active = TRUE,
       last_subscription_status = EXCLUDED.last_subscription_status,
       last_error = EXCLUDED.last_error,
       updated_at = NOW()
     RETURNING *`,
    [
      groupId,
      telegramGroupId,
      groupName || null,
      String(pageId),
      pageName,
      accessTokenEncrypted,
      tokenLast4 || null,
      connectedByFacebookUserId || null,
      connectedByFacebookUserName || null,
      Array.isArray(grantedTasks) ? grantedTasks : [],
      Array.isArray(grantedScopes) ? grantedScopes : [],
      Array.isArray(subscribedFields) ? subscribedFields : [],
      lastSubscriptionStatus || null,
      lastError || null,
    ]
  );
  return res.rows[0] || null;
}

async function getFacebookPageConnectionByPageId(pageId) {
  const res = await query(
    `SELECT *
       FROM facebook_page_connections
      WHERE page_id = $1
        AND is_active = TRUE
      LIMIT 1`,
    [String(pageId)]
  );
  return res.rows[0] || null;
}

async function getFacebookPageConnectionsByTelegramGroupId(telegramGroupId) {
  const res = await query(
    `SELECT *
       FROM facebook_page_connections
      WHERE telegram_group_id = $1
      ORDER BY page_name ASC`,
    [telegramGroupId]
  );
  return res.rows;
}

async function deactivateFacebookPageConnection(pageId) {
  const res = await query(
    `UPDATE facebook_page_connections
        SET is_active = FALSE,
            updated_at = NOW()
      WHERE page_id = $1
      RETURNING *`,
    [String(pageId)]
  );
  return res.rows[0] || null;
}

async function listFacebookPageConnectionsAdmin() {
  const res = await query(
    `SELECT id,
            page_id,
            page_name,
            telegram_group_id,
            group_name,
            is_active,
            connected_at,
            updated_at,
            last_subscription_status,
            last_error
       FROM facebook_page_connections
      ORDER BY page_name ASC, id ASC`
  );
  return res.rows;
}

module.exports = {
  upsertFacebookPageConnection,
  getFacebookPageConnectionByPageId,
  getFacebookPageConnectionsByTelegramGroupId,
  deactivateFacebookPageConnection,
  listFacebookPageConnectionsAdmin,
};
