/**
 * Dispatch ETA update settings + claim/complete scheduling rows
 * (plus getAllDriverGroups, which the ETA scheduler shares with broadcasts).
 * Extracted verbatim from database/db.js; db.js re-exports these.
 */
const { query } = require('./pool');

async function getDriverGroupsWithDispatchEtaSettings() {
  const res = await query(
    `SELECT g.id,
            g.group_name,
            g.telegram_group_id,
            g.language,
            g.active,
            COALESCE(e.enabled, FALSE) AS eta_enabled,
            COALESCE(e.target_mode, 'driver') AS eta_target_mode,
            COALESCE(e.interval_minutes, 60) AS eta_interval_minutes,
            e.next_run_at AS eta_next_run_at,
            e.last_run_at AS eta_last_run_at,
            e.last_status AS eta_last_status,
            e.last_error AS eta_last_error
     FROM groups g
     LEFT JOIN dispatch_eta_updates e ON e.group_id = g.id
     WHERE g.group_type = 'driver'
       AND g.active = TRUE
     ORDER BY g.id ASC`
  );
  return res.rows;
}

async function getDispatchEtaSettingByGroupId(groupId) {
  const res = await query(
    `SELECT *
     FROM dispatch_eta_updates
     WHERE group_id = $1
     LIMIT 1`,
    [groupId]
  );
  return res.rows[0] || null;
}

async function upsertDispatchEtaSetting({
  groupId,
  enabled,
  targetMode = 'driver',
  intervalMinutes,
  nextRunAt = null,
}) {
  const normalizedEnabled = (() => {
    if (typeof enabled === 'boolean') return enabled;
    if (typeof enabled === 'string') {
      const value = enabled.trim().toLowerCase();
      if (value === 'true') return true;
      if (value === 'false') return false;
    }
    if (typeof enabled === 'number') return enabled === 1;
    return false;
  })();
  const normalizedTargetMode = String(targetMode || 'driver').trim().toLowerCase() === 'test'
    ? 'test'
    : 'driver';
  const normalizedInterval = Number.isInteger(intervalMinutes) ? intervalMinutes : 60;
  const res = await query(
    `INSERT INTO dispatch_eta_updates (group_id, enabled, target_mode, interval_minutes, next_run_at, processing, processing_started_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, FALSE, NULL, NOW())
     ON CONFLICT (group_id)
     DO UPDATE SET enabled = EXCLUDED.enabled,
                  target_mode = EXCLUDED.target_mode,
                  interval_minutes = EXCLUDED.interval_minutes,
                  next_run_at = EXCLUDED.next_run_at,
                   processing = FALSE,
                   processing_started_at = NULL,
                   updated_at = NOW()
     RETURNING *`,
    [groupId, normalizedEnabled, normalizedTargetMode, normalizedInterval, nextRunAt]
  );
  return res.rows[0];
}

async function getDispatchEtaGlobalSettings() {
  try {
    const res = await query(
      'SELECT driver_interval_minutes, test_interval_minutes FROM dispatch_eta_global_settings WHERE id = 1'
    );
    if (res.rows[0]) return res.rows[0];
  } catch (err) {
    console.warn('[DB] dispatch_eta_global_settings unavailable:', err.message);
  }
  return { driver_interval_minutes: 60, test_interval_minutes: 60 };
}

async function setDispatchEtaGlobalIntervals(driverMinutes, testMinutes) {
  const res = await query(
    `INSERT INTO dispatch_eta_global_settings (id, driver_interval_minutes, test_interval_minutes, updated_at)
     VALUES (1, $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET
       driver_interval_minutes = EXCLUDED.driver_interval_minutes,
       test_interval_minutes = EXCLUDED.test_interval_minutes,
       updated_at = NOW()
     RETURNING driver_interval_minutes, test_interval_minutes`,
    [driverMinutes, testMinutes]
  );
  return res.rows[0];
}

/** Push stored globals onto every dispatch_eta_updates row by target_mode. */
async function applyDispatchEtaIntervalsFromGlobals() {
  const g = await getDispatchEtaGlobalSettings();
  await query(
    `UPDATE dispatch_eta_updates SET interval_minutes = $1, updated_at = NOW() WHERE target_mode = 'driver'`,
    [g.driver_interval_minutes]
  );
  await query(
    `UPDATE dispatch_eta_updates SET interval_minutes = $1, updated_at = NOW() WHERE target_mode = 'test'`,
    [g.test_interval_minutes]
  );
  return g;
}

async function claimDispatchEtaUpdateByGroupId(groupId) {
  const res = await query(
    `UPDATE dispatch_eta_updates
     SET processing = TRUE,
         processing_started_at = NOW(),
         updated_at = NOW()
     WHERE group_id = $1
       AND enabled = TRUE
       AND (processing = FALSE OR processing_started_at < NOW() - INTERVAL '10 minutes')
     RETURNING *`,
    [groupId]
  );
  return res.rows[0] || null;
}

async function claimDueDispatchEtaUpdates(limit = 20) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 20;
  const res = await query(
    `WITH due AS (
       SELECT id
       FROM dispatch_eta_updates
       WHERE enabled = TRUE
         AND next_run_at IS NOT NULL
         AND next_run_at <= NOW()
         AND (processing = FALSE OR processing_started_at < NOW() - INTERVAL '10 minutes')
       ORDER BY next_run_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE dispatch_eta_updates e
     SET processing = TRUE,
         processing_started_at = NOW(),
         updated_at = NOW()
     FROM due
     WHERE e.id = due.id
     RETURNING e.*`,
    [safeLimit]
  );
  return res.rows;
}

async function completeDispatchEtaUpdateSuccess({
  id,
  nextRunAt,
  lastStatus = 'sent',
  lastPinnedSignature = null,
  cachedPickup = null,
  cachedDelivery = null,
  cachedDestinationQuery = null,
  cachedContextJson = null,
}) {
  const res = await query(
    `UPDATE dispatch_eta_updates
     SET processing = FALSE,
         processing_started_at = NULL,
         last_run_at = NOW(),
         last_status = $2,
         last_error = NULL,
         next_run_at = $3,
         last_pinned_signature = $4,
         cached_pickup = $5,
         cached_delivery = $6,
         cached_destination_query = $7,
         cached_context_json = $8,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      lastStatus,
      nextRunAt,
      lastPinnedSignature,
      cachedPickup,
      cachedDelivery,
      cachedDestinationQuery,
      cachedContextJson ? JSON.stringify(cachedContextJson) : null,
    ]
  );
  return res.rows[0] || null;
}

async function completeDispatchEtaUpdateFailure({ id, nextRunAt, errorMessage }) {
  const res = await query(
    `UPDATE dispatch_eta_updates
     SET processing = FALSE,
         processing_started_at = NULL,
         last_run_at = NOW(),
         last_status = 'failed',
         last_error = $2,
         next_run_at = $3,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, String(errorMessage || 'Unknown ETA update error').slice(0, 1000), nextRunAt]
  );
  return res.rows[0] || null;
}


module.exports = {
  getDriverGroupsWithDispatchEtaSettings,
  getDispatchEtaSettingByGroupId,
  upsertDispatchEtaSetting,
  getDispatchEtaGlobalSettings,
  setDispatchEtaGlobalIntervals,
  applyDispatchEtaIntervalsFromGlobals,
  claimDispatchEtaUpdateByGroupId,
  claimDueDispatchEtaUpdates,
  completeDispatchEtaUpdateSuccess,
  completeDispatchEtaUpdateFailure,
};
