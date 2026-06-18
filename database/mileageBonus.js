/**
 * Database helpers for the mileage bonus feature.
 * Uses the shared pool/query exported from db.js.
 */
const { query } = require('./db');

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
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
     ON CONFLICT (driver_normalized_name, threshold_miles) DO NOTHING
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
    ]
  );
  return res.rows[0] || null;
}

async function setBonusNotificationMessage(id, chatId, messageId) {
  const res = await query(
    `UPDATE mileage_bonus_notifications
       SET telegram_chat_id = $2, telegram_message_id = $3
     WHERE id = $1
     RETURNING *`,
    [id, chatId, messageId]
  );
  return res.rows[0] || null;
}

/** Delete a claimed notification that failed to actually send (so a later run can retry). */
async function deleteBonusNotification(id) {
  await query('DELETE FROM mileage_bonus_notifications WHERE id = $1', [id]);
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
    `UPDATE mileage_bonus_notifications
       SET status = $2,
           decided_by_username = $3,
           decided_by_user_id = $4,
           decided_at = NOW()
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
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

module.exports = {
  claimBonusNotification,
  setBonusNotificationMessage,
  deleteBonusNotification,
  getBonusNotificationById,
  decideBonusNotification,
  getNotifiedTierKeys,
  listBonusNotifications,
  upsertDriverProgress,
  listDriverProgress,
};
