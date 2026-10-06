/**
 * Whether driver-group messages are recorded (migration 0065).
 *
 * Read on every driver-group message, so it is cached for a minute. A read
 * that fails answers "not enabled": a privacy switch that cannot be read must
 * fail closed, never record by accident.
 */
const { query } = require('./pool');

const CACHE_MS = 60 * 1000;
let cache = { at: 0, value: null };

function invalidateChatCaptureCache() {
  cache = { at: 0, value: null };
}

async function getChatCaptureSettings() {
  const now = Date.now();
  if (cache.value && now - cache.at < CACHE_MS) return cache.value;
  try {
    const res = await query(
      'SELECT enabled, updated_at, updated_by FROM driver_chat_capture_settings WHERE id = 1'
    );
    const row = res.rows[0];
    const value = {
      enabled: row?.enabled === true,
      updatedAt: row?.updated_at || null,
      updatedBy: row?.updated_by || null,
    };
    cache = { at: now, value };
    return value;
  } catch (err) {
    return { enabled: false, updatedAt: null, updatedBy: null, error: err.message };
  }
}

async function setChatCaptureEnabled(enabled, { updatedBy = null } = {}) {
  const res = await query(
    `INSERT INTO driver_chat_capture_settings (id, enabled, updated_at, updated_by)
     VALUES (1, $1, NOW(), $2)
     ON CONFLICT (id) DO UPDATE
       SET enabled = EXCLUDED.enabled, updated_at = NOW(), updated_by = EXCLUDED.updated_by
     RETURNING enabled, updated_at, updated_by`,
    [enabled === true, updatedBy]
  );
  invalidateChatCaptureCache();
  const row = res.rows[0];
  return { enabled: row.enabled === true, updatedAt: row.updated_at, updatedBy: row.updated_by };
}

module.exports = { CACHE_MS, getChatCaptureSettings, setChatCaptureEnabled, invalidateChatCaptureCache };
