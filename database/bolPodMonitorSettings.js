/**
 * Silent BOL/POD test-monitor settings — single-row store (id = 1).
 *
 * Backs admin Settings → BOL/POD Monitor. The DATABASE is the source of truth
 * (the admin panel writes here) — there are deliberately NO Render env vars for
 * these values. Nothing here is a secret, so values are returned in plaintext.
 *
 * Fail-safe: if the row/table cannot be read, `getEffectiveSettings()` returns a
 * DISABLED config so the monitor never sends anything on a bad/missing DB.
 *
 * The effective config is read on a hot path (per document message), so it is
 * cached briefly to avoid a DB hit on every batch.
 */
const { query } = require('./db');

// Default test group: "Automatic updating (Test)" Telegram group.
const DEFAULT_TEST_GROUP_ID = '-5289094495';

const CACHE_TTL_MS = 15_000;
let cache = null;
let cacheExpiresAt = 0;

function invalidateCache() {
  cache = null;
  cacheExpiresAt = 0;
}

async function getSettingsRow() {
  try {
    const res = await query('SELECT * FROM bol_pod_monitor_settings WHERE id = 1');
    return res.rows[0] || null;
  } catch (err) {
    // Table may not exist yet on a brand-new DB before initializeDatabase ran.
    console.warn('[BOLPOD MONITOR] bol_pod_monitor_settings unavailable:', err.message);
    return null;
  }
}

/** The always-safe fallback used when the DB row cannot be read. */
function disabledFallback() {
  return {
    enabled: false,
    testGroupId: DEFAULT_TEST_GROUP_ID,
    sendUnrelated: true,
    sendUnclear: true,
    sendFiles: true,
    lastReportAt: null,
    reportCount: 0,
    updatedAt: null,
    updatedBy: null,
    loaded: false, // false ⇒ we could not read settings; caller must fail safe
  };
}

function mapRow(row) {
  if (!row) return disabledFallback();
  return {
    enabled: row.test_monitor_enabled === true,
    // BIGINT comes back from pg as a string — keep it a string so a large
    // negative chat id never loses precision. Telegram accepts string chat ids.
    testGroupId: row.test_group_id != null ? String(row.test_group_id) : null,
    sendUnrelated: row.test_send_unrelated === true,
    sendUnclear: row.test_send_unclear === true,
    sendFiles: row.test_send_files === true,
    lastReportAt: row.last_report_at || null,
    reportCount: Number(row.report_count) || 0,
    updatedAt: row.updated_at || null,
    updatedBy: row.updated_by || null,
    loaded: true,
  };
}

/**
 * Effective settings for the monitor (cached). Never throws — on any DB error it
 * returns the disabled fallback so the monitor stays silent.
 */
async function getEffectiveSettings() {
  const now = Date.now();
  if (cache && now < cacheExpiresAt) return cache;
  const row = await getSettingsRow();
  const effective = mapRow(row);
  cache = effective;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return effective;
}

/** Fresh (uncached) admin view — reflects a just-saved change immediately. */
async function getSettingsForAdmin() {
  const row = await getSettingsRow();
  return mapRow(row);
}

/** Is a value a valid Telegram chat id (integer, may be negative)? */
function isValidTelegramChatId(value) {
  const s = String(value == null ? '' : value).trim();
  return /^-?\d{1,19}$/.test(s);
}

/**
 * Update settings. Unknown keys are ignored (only the known columns are ever
 * written). Throws on an invalid test_group_id. `updatedBy` is recorded for
 * audit. Returns the fresh admin view.
 */
async function updateSettings(payload = {}, updatedBy = null) {
  const sets = [];
  const values = [];
  let i = 1;

  const pushBool = (column, value) => {
    if (typeof value === 'boolean') { sets.push(`${column} = $${i++}`); values.push(value); }
  };

  pushBool('test_monitor_enabled', payload.test_monitor_enabled);
  pushBool('test_send_unrelated', payload.test_send_unrelated);
  pushBool('test_send_unclear', payload.test_send_unclear);
  pushBool('test_send_files', payload.test_send_files);

  if (payload.test_group_id !== undefined && payload.test_group_id !== null && payload.test_group_id !== '') {
    if (!isValidTelegramChatId(payload.test_group_id)) {
      const err = new Error('test_group_id must be a valid Telegram chat id (an integer, e.g. -5289094495).');
      err.statusCode = 400;
      throw err;
    }
    sets.push(`test_group_id = $${i++}`);
    values.push(String(payload.test_group_id).trim());
  }

  if (!sets.length) {
    // Nothing valid to change; still refresh updated_by/updated_at if provided.
    if (updatedBy) {
      await query('UPDATE bol_pod_monitor_settings SET updated_at = NOW(), updated_by = $1 WHERE id = 1', [String(updatedBy)]);
      invalidateCache();
    }
    return getSettingsForAdmin();
  }

  sets.push(`updated_at = NOW()`);
  sets.push(`updated_by = $${i++}`);
  values.push(updatedBy != null ? String(updatedBy) : null);

  await query(`UPDATE bol_pod_monitor_settings SET ${sets.join(', ')} WHERE id = 1`, values);
  invalidateCache();
  return getSettingsForAdmin();
}

/**
 * Best-effort audit stamp after a report is delivered to the test group.
 * Never throws (a stats update must not break the monitor).
 */
async function recordReportSent(count = 1) {
  try {
    await query(
      'UPDATE bol_pod_monitor_settings SET last_report_at = NOW(), report_count = report_count + $1 WHERE id = 1',
      [Number.isFinite(count) ? Math.max(1, Math.round(count)) : 1]
    );
    invalidateCache();
  } catch (err) {
    console.warn('[BOLPOD MONITOR] recordReportSent failed:', err.message);
  }
}

module.exports = {
  DEFAULT_TEST_GROUP_ID,
  getEffectiveSettings,
  getSettingsForAdmin,
  updateSettings,
  recordReportSent,
  invalidateCache,
  isValidTelegramChatId,
};
