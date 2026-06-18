/**
 * Database helpers for the mileage bonus feature.
 * Uses the shared pool/query exported from db.js.
 */
const { query, pool } = require('./db');

const RUN_LOCK_NAME = 'mileage_bonus:global_run';
const ACTION_STALE_MINUTES = 10;
const DELIVERY_STALE_MINUTES = 30;

/**
 * Insert a milestone notification record. The UNIQUE (driver, threshold)
 * constraint makes this the idempotency guard — returns the row when newly
 * claimed, or null if this (driver, threshold) was already notified.
 */
async function claimBonusNotification(data) {
  const res = await query(
    `INSERT INTO mileage_bonus_notifications (
       driver_external_id, driver_normalized_name, driver_name,
       threshold_miles, bonus_amount, miles_at_notification,
       period_start, period_end, trigger, status
     )
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending'
     WHERE NOT EXISTS (
       SELECT 1 FROM mileage_bonus_progress
       WHERE driver_normalized_name = $2 AND is_active = FALSE
     )
     ON CONFLICT (driver_normalized_name, threshold_miles) DO UPDATE SET
       driver_external_id = EXCLUDED.driver_external_id,
       driver_name = EXCLUDED.driver_name,
       miles_at_notification = EXCLUDED.miles_at_notification,
       period_start = EXCLUDED.period_start,
       period_end = EXCLUDED.period_end,
       trigger = EXCLUDED.trigger,
       delivery_state = 'pending',
       delivery_started_at = NOW(),
       last_action_error = NULL
     WHERE mileage_bonus_notifications.status = 'pending'
       AND mileage_bonus_notifications.telegram_message_id IS NULL
       AND (
         mileage_bonus_notifications.delivery_state = 'failed'
         OR mileage_bonus_notifications.delivery_started_at
              < NOW() - ($10 * INTERVAL '1 minute')
       )
     RETURNING *`,
    [
      data.driver_external_id || null,
      data.driver_normalized_name,
      data.driver_name,
      data.threshold_miles,
      data.bonus_amount,
      data.miles_at_notification,
      data.period_start || null,
      data.period_end || null,
      data.trigger || 'scheduled',
      DELIVERY_STALE_MINUTES,
    ]
  );
  return res.rows[0] || null;
}

async function setBonusNotificationMessage(id, chatId, messageId) {
  const res = await query(
    `UPDATE mileage_bonus_notifications
       SET telegram_chat_id = $2,
           telegram_message_id = $3,
           delivery_state = 'sent',
           last_action_error = NULL
     WHERE id = $1
     RETURNING *`,
    [id, chatId, messageId]
  );
  return res.rows[0] || null;
}

async function markBonusNotificationDeliveryFailed(id, error) {
  const res = await query(
    `UPDATE mileage_bonus_notifications
       SET delivery_state = 'failed', last_action_error = $2
     WHERE id = $1 AND telegram_message_id IS NULL
     RETURNING *`,
    [id, String(error || 'Telegram delivery failed').slice(0, 2000)]
  );
  return res.rows[0] || null;
}

async function setBonusNotificationFollowupMessage(id, messageId) {
  const res = await query(
    `UPDATE mileage_bonus_notifications
       SET telegram_followup_message_id = $2
     WHERE id = $1
     RETURNING *`,
    [id, messageId]
  );
  return res.rows[0] || null;
}

async function getBonusNotificationById(id) {
  const res = await query(
    'SELECT * FROM mileage_bonus_notifications WHERE id = $1',
    [id]
  );
  return res.rows[0] || null;
}

/**
 * Record an accounting decision (paid/rejected) on a pending notification.
 * Only transitions from 'pending' so a second click is a no-op.
 * Returns { record, alreadyDecided }.
 */
async function decideBonusNotification(id, { status, username, userId }) {
  const res = await query(
    `UPDATE mileage_bonus_notifications AS notification
       SET status = $2,
           decided_by_username = $3,
           decided_by_user_id = $4,
           decided_at = NOW()
     FROM mileage_bonus_progress AS progress
     WHERE notification.id = $1
       AND notification.status = 'pending'
       AND notification.action_state = 'idle'
       AND progress.driver_normalized_name = notification.driver_normalized_name
       AND progress.is_active = TRUE
     RETURNING notification.*`,
    [id, status, username || null, userId || null]
  );
  if (res.rows[0]) {
    return { record: res.rows[0], alreadyDecided: false };
  }
  const existing = await getBonusNotificationById(id);
  return { record: existing, alreadyDecided: Boolean(existing) };
}

/** Set of "driver_normalized_name|threshold" already notified (any status). */
async function getNotifiedTierKeys() {
  const res = await query(
    'SELECT driver_normalized_name, threshold_miles FROM mileage_bonus_notifications'
  );
  return new Set(res.rows.map((r) => `${r.driver_normalized_name}|${r.threshold_miles}`));
}

async function listBonusNotifications({ limit = 200 } = {}) {
  const res = await query(
    `SELECT * FROM mileage_bonus_notifications
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return res.rows;
}

async function claimNotificationAction(id, action) {
  const res = await query(
    `UPDATE mileage_bonus_notifications
       SET action_state = $2, action_started_at = NOW(), last_action_error = NULL
     WHERE id = $1
       AND status <> 'paid'
       AND (
         $2 <> 'resending'
         OR EXISTS (
           SELECT 1 FROM mileage_bonus_progress
           WHERE driver_normalized_name = mileage_bonus_notifications.driver_normalized_name
             AND is_active = TRUE
         )
       )
       AND (
         action_state = 'idle'
         OR action_started_at < NOW() - ($3 * INTERVAL '1 minute')
       )
     RETURNING *`,
    [id, action, ACTION_STALE_MINUTES]
  );
  return res.rows[0] || null;
}

async function releaseNotificationAction(id, error) {
  const res = await query(
    `UPDATE mileage_bonus_notifications
       SET action_state = 'idle', action_started_at = NULL, last_action_error = $2
     WHERE id = $1
     RETURNING *`,
    [id, error ? String(error).slice(0, 2000) : null]
  );
  return res.rows[0] || null;
}

async function finalizeNotificationResend(id, { chatId, messageId, username }) {
  const res = await query(
    `UPDATE mileage_bonus_notifications
       SET telegram_chat_id = $2,
           telegram_message_id = $3,
           telegram_followup_message_id = NULL,
           delivery_state = 'sent',
           delivery_started_at = NOW(),
           status = 'pending',
           decided_by_username = NULL,
           decided_by_user_id = NULL,
           decided_at = NULL,
           disregarded_by_username = NULL,
           disregarded_at = NULL,
           resend_count = resend_count + 1,
           last_resent_at = NOW(),
           last_resent_by_username = $4,
           action_state = 'idle',
           action_started_at = NULL,
           last_action_error = NULL,
           telegram_deleted_at = NULL,
           telegram_delete_error = NULL
     WHERE id = $1
       AND action_state = 'resending'
       AND EXISTS (
         SELECT 1 FROM mileage_bonus_progress
         WHERE driver_normalized_name = mileage_bonus_notifications.driver_normalized_name
           AND is_active = TRUE
       )
     RETURNING *`,
    [id, chatId, messageId, username || null]
  );
  return res.rows[0] || null;
}

async function markNotificationDisregarded(id, username) {
  const res = await query(
    `UPDATE mileage_bonus_notifications
       SET status = 'disregarded',
           disregarded_by_username = $2,
           disregarded_at = NOW(),
           decided_by_username = NULL,
           decided_by_user_id = NULL,
           decided_at = NULL
     WHERE id = $1 AND action_state = 'disregarding' AND status <> 'paid'
     RETURNING *`,
    [id, username || null]
  );
  return res.rows[0] || null;
}

async function completeNotificationCleanup(id, { deleted, error }) {
  const res = await query(
    `UPDATE mileage_bonus_notifications
       SET action_state = 'idle',
           action_started_at = NULL,
           telegram_deleted_at = CASE WHEN $2 THEN NOW() ELSE telegram_deleted_at END,
           telegram_delete_error = $3,
           last_action_error = $3
     WHERE id = $1
     RETURNING *`,
    [id, Boolean(deleted), error ? String(error).slice(0, 2000) : null]
  );
  return res.rows[0] || null;
}

async function listOpenNotificationsForDriver(normalizedName) {
  const res = await query(
    `SELECT * FROM mileage_bonus_notifications
     WHERE driver_normalized_name = $1
       AND status NOT IN ('paid', 'disregarded')
     ORDER BY threshold_miles ASC`,
    [normalizedName]
  );
  return res.rows;
}

/** Upsert the latest computed progress snapshot for a driver. */
async function upsertDriverProgress(data) {
  const res = await query(
    `INSERT INTO mileage_bonus_progress (
       driver_external_id, driver_normalized_name, driver_name, driver_type,
       hire_date, period_start, period_end, total_miles, trips,
       highest_tier_reached, next_tier, miles_to_next_tier, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
     ON CONFLICT (driver_normalized_name) DO UPDATE SET
       driver_external_id = EXCLUDED.driver_external_id,
       driver_name = EXCLUDED.driver_name,
       driver_type = EXCLUDED.driver_type,
       hire_date = EXCLUDED.hire_date,
       period_start = EXCLUDED.period_start,
       period_end = EXCLUDED.period_end,
       total_miles = EXCLUDED.total_miles,
       trips = EXCLUDED.trips,
       highest_tier_reached = EXCLUDED.highest_tier_reached,
       next_tier = EXCLUDED.next_tier,
       miles_to_next_tier = EXCLUDED.miles_to_next_tier,
       updated_at = NOW()
     WHERE mileage_bonus_progress.is_active = TRUE
     RETURNING *`,
    [
      data.driver_external_id || null,
      data.driver_normalized_name,
      data.driver_name,
      data.driver_type || null,
      data.hire_date || null,
      data.period_start || null,
      data.period_end || null,
      data.total_miles,
      data.trips || 0,
      data.highest_tier_reached ?? null,
      data.next_tier ?? null,
      data.miles_to_next_tier ?? null,
    ]
  );
  return res.rows[0];
}

async function listDriverProgress() {
  const res = await query(
    'SELECT * FROM mileage_bonus_progress ORDER BY total_miles DESC'
  );
  return res.rows;
}

async function listInactiveDriverKeys() {
  const res = await query(
    'SELECT driver_normalized_name FROM mileage_bonus_progress WHERE is_active = FALSE'
  );
  return new Set(res.rows.map((row) => row.driver_normalized_name));
}

async function isDriverActive(normalizedName) {
  const res = await query(
    'SELECT is_active FROM mileage_bonus_progress WHERE driver_normalized_name = $1',
    [normalizedName]
  );
  return res.rows[0] ? res.rows[0].is_active !== false : true;
}

async function setDriverActive(normalizedName, isActive, username) {
  const res = await query(
    `UPDATE mileage_bonus_progress
       SET is_active = $2,
           activation_updated_at = NOW(),
           activation_updated_by = $3
     WHERE driver_normalized_name = $1
     RETURNING *`,
    [normalizedName, Boolean(isActive), username || null]
  );
  return res.rows[0] || null;
}

async function withMileageRunLock(fn) {
  const client = await pool.connect();
  let acquired = false;
  try {
    const lock = await client.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
      [RUN_LOCK_NAME]
    );
    acquired = Boolean(lock.rows[0]?.acquired);
    if (!acquired) return { acquired: false, result: null };
    return { acquired: true, result: await fn() };
  } finally {
    if (acquired) {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [RUN_LOCK_NAME]).catch(() => {});
    }
    client.release();
  }
}

async function claimMileageBonusRun({ runKey, trigger, mode, requestedBy, leaseMinutes = 45 }) {
  const res = await query(
    `INSERT INTO mileage_bonus_runs (
       run_key, trigger, mode, status, requested_by, lease_expires_at
     ) VALUES ($1, $2, $3, 'running', $4, NOW() + ($5 * INTERVAL '1 minute'))
     ON CONFLICT (run_key) DO UPDATE SET
       status = 'running',
       attempt_count = mileage_bonus_runs.attempt_count + 1,
       requested_by = EXCLUDED.requested_by,
       started_at = NOW(),
       lease_expires_at = EXCLUDED.lease_expires_at,
       next_retry_at = NULL,
       finished_at = NULL,
       error = NULL,
       summary = NULL
     WHERE (
       mileage_bonus_runs.status = 'failed'
       AND COALESCE(mileage_bonus_runs.next_retry_at, NOW()) <= NOW()
     ) OR (
       mileage_bonus_runs.status = 'running'
       AND mileage_bonus_runs.lease_expires_at < NOW()
     )
     RETURNING *`,
    [runKey, trigger, mode, requestedBy || null, leaseMinutes]
  );
  return res.rows[0] || null;
}

async function completeMileageBonusRun(id, summary) {
  const res = await query(
    `UPDATE mileage_bonus_runs
       SET status = 'succeeded', finished_at = NOW(), lease_expires_at = NOW(),
           summary = $2::jsonb, error = NULL, next_retry_at = NULL
     WHERE id = $1
     RETURNING *`,
    [id, JSON.stringify(summary || {})]
  );
  return res.rows[0] || null;
}

async function failMileageBonusRun(id, error, retryDelayMinutes, summary = null) {
  const res = await query(
    `UPDATE mileage_bonus_runs
       SET status = 'failed', finished_at = NOW(), lease_expires_at = NOW(),
           error = $2, next_retry_at = NOW() + ($3 * INTERVAL '1 minute'),
           summary = $4::jsonb
     WHERE id = $1
     RETURNING *`,
    [
      id,
      String(error || 'Mileage bonus run failed').slice(0, 4000),
      retryDelayMinutes,
      summary ? JSON.stringify(summary) : null,
    ]
  );
  return res.rows[0] || null;
}

async function getLatestMileageBonusRun() {
  const res = await query(
    'SELECT * FROM mileage_bonus_runs ORDER BY started_at DESC LIMIT 1'
  );
  return res.rows[0] || null;
}

async function isMileageBonusRunActive() {
  const res = await query(
    `SELECT 1 FROM mileage_bonus_runs
     WHERE status = 'running' AND lease_expires_at > NOW()
     LIMIT 1`
  );
  return res.rows.length > 0;
}

module.exports = {
  claimBonusNotification,
  setBonusNotificationMessage,
  markBonusNotificationDeliveryFailed,
  setBonusNotificationFollowupMessage,
  getBonusNotificationById,
  decideBonusNotification,
  getNotifiedTierKeys,
  listBonusNotifications,
  claimNotificationAction,
  releaseNotificationAction,
  finalizeNotificationResend,
  markNotificationDisregarded,
  completeNotificationCleanup,
  listOpenNotificationsForDriver,
  upsertDriverProgress,
  listDriverProgress,
  listInactiveDriverKeys,
  isDriverActive,
  setDriverActive,
  withMileageRunLock,
  claimMileageBonusRun,
  completeMileageBonusRun,
  failMileageBonusRun,
  getLatestMileageBonusRun,
  isMileageBonusRunActive,
};
