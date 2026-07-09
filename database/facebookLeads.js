/**
 * Facebook leads infrastructure: connect sessions, page connections, webhook
 * event queue, auto-message config, and SMS mirrors.
 * Extracted verbatim from database/db.js; db.js re-exports these.
 */
const { pool, query } = require('./pool');

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

async function insertFacebookWebhookEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const inserted = [];
  for (const event of events) {
    const res = await query(
      `INSERT INTO facebook_webhook_events (
         event_key,
         page_id,
         event_type,
         payload
       )
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (event_key) DO NOTHING
       RETURNING *`,
      [
        event.eventKey,
        String(event.pageId),
        event.eventType,
        JSON.stringify(event.payload || {}),
      ]
    );
    if (res.rows[0]) inserted.push(res.rows[0]);
  }
  return inserted;
}

async function claimPendingFacebookWebhookEvents(limit = 10) {
  const res = await query(
    `WITH candidates AS (
       SELECT id
         FROM facebook_webhook_events
        WHERE status IN ('pending', 'failed')
          AND next_retry_at <= NOW()
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE facebook_webhook_events e
        SET status = 'processing',
            attempt_count = e.attempt_count + 1,
            updated_at = NOW()
       FROM candidates
      WHERE e.id = candidates.id
      RETURNING e.*`,
    [limit]
  );
  return res.rows;
}

async function completeFacebookWebhookEvent(eventId) {
  const res = await query(
    `UPDATE facebook_webhook_events
        SET status = 'completed',
            processed_at = NOW(),
            updated_at = NOW(),
            last_error = NULL
      WHERE id = $1
      RETURNING *`,
    [eventId]
  );
  return res.rows[0] || null;
}

async function failFacebookWebhookEvent(eventId, errorMessage, nextRetryAt) {
  const res = await query(
    `UPDATE facebook_webhook_events
        SET status = 'failed',
            last_error = $1,
            next_retry_at = $2,
            updated_at = NOW()
      WHERE id = $3
      RETURNING *`,
    [String(errorMessage || 'Unknown error').slice(0, 2000), nextRetryAt, eventId]
  );
  return res.rows[0] || null;
}

async function resetFacebookWebhookEventByIdentifier(identifier) {
  const normalized = String(identifier || '').trim();
  if (!normalized) return null;
  const res = await query(
    `UPDATE facebook_webhook_events
        SET status = 'pending',
            next_retry_at = NOW(),
            updated_at = NOW(),
            last_error = NULL
      WHERE id::text = $1
         OR event_key = $1
         OR event_key LIKE '%' || $1
      RETURNING *`,
    [normalized]
  );
  return res.rows[0] || null;
}

async function getRecentFacebookWebhookEvents(limit = 50) {
  const cappedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const res = await query(
    `SELECT *
       FROM facebook_webhook_events
      ORDER BY created_at DESC
      LIMIT $1`,
    [cappedLimit]
  );
  return res.rows;
}

async function recordFacebookSenderSeen(pageId, senderId, firstEventKey) {
  const res = await query(
    `INSERT INTO facebook_seen_senders (
       page_id,
       sender_id,
       first_event_key,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (page_id, sender_id) DO NOTHING
     RETURNING page_id, sender_id`,
    [String(pageId), String(senderId), firstEventKey || null]
  );
  return res.rows.length > 0;
}

async function hasFacebookSenderBeenSeen(pageId, senderId) {
  const res = await query(
    `SELECT 1
       FROM facebook_seen_senders
      WHERE page_id = $1
        AND sender_id = $2
      LIMIT 1`,
    [String(pageId), String(senderId)]
  );
  return res.rows.length > 0;
}

const DEFAULT_WORKING_HOURS_TEMPLATE = (
  'Hello {first_name}, this is {rep_name} with {company_name} '
  + 'and thanks for applying to our {position}. '
  + 'Can I call you right now to explain the details?'
);

const DEFAULT_FALLBACK_TEMPLATE = (
  'Hello {first_name}, this is {rep_name} with {company_name}. '
  + 'Thanks for applying to our {position}. '
  + 'When is a good time for me to call you and explain the details?'
);

async function seedFacebookLeadAutoMessageDefaults() {
  const existing = await query(
    'SELECT id FROM facebook_lead_auto_message_settings ORDER BY id LIMIT 1'
  );
  if (existing.rows.length > 0) return;

  const settingsRes = await query(
    `INSERT INTO facebook_lead_auto_message_settings (
       timezone,
       is_enabled,
       rep_name,
       company_name,
       position_label,
       fallback_template
     )
     VALUES ($1, TRUE, $2, $3, $4, $5)
     RETURNING id`,
    [
      'America/Chicago',
      'Tom',
      'Wenze trucking company',
      'OTR position',
      DEFAULT_FALLBACK_TEMPLATE,
    ]
  );
  const settingsId = settingsRes.rows[0].id;

  await query(
    `INSERT INTO facebook_lead_auto_message_rules (
       settings_id,
       label,
       days_of_week,
       start_time_local,
       end_time_local,
       message_template,
       sort_order,
       is_active
     )
     VALUES ($1, $2, $3, $4, $5, $6, 0, TRUE)`,
    [
      settingsId,
      'Working hours',
      [1, 2, 3, 4, 5],
      '08:00',
      '17:00',
      DEFAULT_WORKING_HOURS_TEMPLATE,
    ]
  );
  console.log('[DB] Seeded default Facebook lead auto-message settings.');
}

async function getFacebookLeadAutoMessageSettings() {
  const settingsRes = await query(
    `SELECT *
       FROM facebook_lead_auto_message_settings
      ORDER BY id
      LIMIT 1`
  );
  const settings = settingsRes.rows[0];
  if (!settings) return { settings: null, rules: [] };

  const rulesRes = await query(
    `SELECT *
       FROM facebook_lead_auto_message_rules
      WHERE settings_id = $1
      ORDER BY sort_order ASC, id ASC`,
    [settings.id]
  );
  return { settings, rules: rulesRes.rows };
}

async function replaceFacebookLeadAutoMessageConfig({ settings, rules }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let settingsId = settings.id;
    if (settingsId) {
      await client.query(
        `UPDATE facebook_lead_auto_message_settings
            SET timezone = $1,
                is_enabled = $2,
                rep_name = $3,
                company_name = $4,
                position_label = $5,
                fallback_template = $6,
                updated_at = NOW()
          WHERE id = $7`,
        [
          settings.timezone,
          settings.is_enabled,
          settings.rep_name,
          settings.company_name,
          settings.position_label,
          settings.fallback_template,
          settingsId,
        ]
      );
    } else {
      const insertRes = await client.query(
        `INSERT INTO facebook_lead_auto_message_settings (
           timezone,
           is_enabled,
           rep_name,
           company_name,
           position_label,
           fallback_template
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          settings.timezone,
          settings.is_enabled,
          settings.rep_name,
          settings.company_name,
          settings.position_label,
          settings.fallback_template,
        ]
      );
      settingsId = insertRes.rows[0].id;
    }

    await client.query(
      'DELETE FROM facebook_lead_auto_message_rules WHERE settings_id = $1',
      [settingsId]
    );

    const insertedRules = [];
    for (let i = 0; i < rules.length; i += 1) {
      const rule = rules[i];
      const res = await client.query(
        `INSERT INTO facebook_lead_auto_message_rules (
           settings_id,
           label,
           days_of_week,
           start_time_local,
           end_time_local,
           message_template,
           sort_order,
           is_active
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          settingsId,
          rule.label,
          rule.days_of_week,
          rule.start_time_local,
          rule.end_time_local,
          rule.message_template,
          rule.sort_order ?? i,
          rule.is_active !== false,
        ]
      );
      insertedRules.push(res.rows[0]);
    }

    const settingsRow = await client.query(
      'SELECT * FROM facebook_lead_auto_message_settings WHERE id = $1',
      [settingsId]
    );

    await client.query('COMMIT');
    return { settings: settingsRow.rows[0], rules: insertedRules };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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

async function insertFacebookLeadSmsMirror({
  telegramChatId,
  telegramMessageId,
  driverPhone,
  smsBody,
  leadName = null,
  pageId = null,
  ruleLabel = null,
  ringcentralMessageId = null,
  sourceType = 'outbound_auto',
}) {
  const res = await query(
    `INSERT INTO facebook_lead_sms_mirrors (
       telegram_chat_id,
       telegram_message_id,
       driver_phone,
       sms_body,
       lead_name,
       page_id,
       rule_label,
       ringcentral_message_id,
       source_type
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (telegram_chat_id, telegram_message_id) DO UPDATE
       SET driver_phone = EXCLUDED.driver_phone,
           sms_body = EXCLUDED.sms_body,
           lead_name = EXCLUDED.lead_name,
           page_id = EXCLUDED.page_id,
           rule_label = EXCLUDED.rule_label,
           ringcentral_message_id = EXCLUDED.ringcentral_message_id,
           source_type = EXCLUDED.source_type
     RETURNING *`,
    [
      telegramChatId,
      telegramMessageId,
      driverPhone,
      smsBody,
      leadName,
      pageId,
      ruleLabel,
      ringcentralMessageId,
      sourceType,
    ]
  );
  return res.rows[0];
}

async function getFacebookLeadSmsMirror(telegramChatId, telegramMessageId) {
  const chatId = Number(telegramChatId);
  const messageId = Number(telegramMessageId);
  if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) return null;

  const res = await query(
    `SELECT *
       FROM facebook_lead_sms_mirrors
      WHERE telegram_chat_id = $1
        AND telegram_message_id = $2
      LIMIT 1`,
    [chatId, messageId]
  );
  return res.rows[0] || null;
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
  upsertFacebookPageConnection,
  getFacebookPageConnectionByPageId,
  getFacebookPageConnectionsByTelegramGroupId,
  deactivateFacebookPageConnection,
  insertFacebookWebhookEvents,
  claimPendingFacebookWebhookEvents,
  completeFacebookWebhookEvent,
  failFacebookWebhookEvent,
  resetFacebookWebhookEventByIdentifier,
  getRecentFacebookWebhookEvents,
  recordFacebookSenderSeen,
  hasFacebookSenderBeenSeen,
  seedFacebookLeadAutoMessageDefaults,
  getFacebookLeadAutoMessageSettings,
  replaceFacebookLeadAutoMessageConfig,
  listFacebookPageConnectionsAdmin,
  insertFacebookLeadSmsMirror,
  getFacebookLeadSmsMirror,
};
