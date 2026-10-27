'use strict';

/**
 * Meta Conversions API for CRM SETTINGS — the single row Settings →
 * Facebook ↔ Bitrix edits (migration 0086), and the effective configuration
 * services/metaCrm/stageSync.js reads on every pass.
 *
 * THE RESOLUTION RULE, in one place (resolveMetaCrmConfig, pure): a NULL column
 * means "not set in the app — inherit META_CRM_DATASET_ID / META_CRM_CAPI_TOKEN",
 * so the env-only setup keeps working until somebody saves. `enabled` NULL is
 * ON, because before this row existed the pass ran whenever both env values
 * were set. A stored token that no longer decrypts (the encryption key changed)
 * counts as not stored — the env token answers, and the panel says why.
 *
 * THE TOKEN IS A SECRET: encrypted at rest, never in the admin view — only
 * its last four characters.
 *
 * SHARED MUTABLE STATE — this module is the sole owner of the settings cache;
 * every writer here calls invalidateMetaCrmSettingsCache(), so a save reaches
 * the next pass with no restart.
 */
const { query } = require('./pool');
const config = require('../config/config');
const { encryptText } = require('../lib/security/facebookCrypto');
const { createSafeDecrypt } = require('../lib/security/secretMasking');

const SETTINGS_CACHE_TTL_MS = 15_000;
const safeDecrypt = createSafeDecrypt('[META-CRM]', 'the stored Conversions API token');

let settingsCache = null;
let settingsCacheExpiresAt = 0;

function invalidateMetaCrmSettingsCache() {
  settingsCache = null;
  settingsCacheExpiresAt = 0;
}

/** The row, or null when it cannot be read — the env then answers alone. */
async function getMetaCrmSettingsRow() {
  try {
    const res = await query('SELECT * FROM meta_crm_settings WHERE id = 1');
    return res.rows[0] || null;
  } catch (err) {
    console.warn('[META-CRM] meta_crm_settings unavailable:', err.message);
    return null;
  }
}

const isUnset = (v) => v === null || v === undefined;
const source = (fromRow, fromEnv) => (fromRow ? 'database' : (fromEnv ? 'environment' : 'none'));

/**
 * The effective configuration for one row over one env. Pure (the decrypt is
 * injectable), so the precedence is unit-tested without a database.
 */
function resolveMetaCrmConfig(row, env = config, decrypt = safeDecrypt) {
  const rowDataset = isUnset(row?.dataset_id) ? '' : String(row.dataset_id).trim();
  const envDataset = String(env.metaCrmDatasetId || '').trim();
  const storedToken = row?.token_encrypted ? decrypt(row.token_encrypted) : '';
  const envToken = String(env.metaCrmCapiToken || '').trim();
  const datasetId = rowDataset || envDataset;
  const token = storedToken || envToken;
  return {
    enabled: isUnset(row?.enabled) ? true : row.enabled === true,
    datasetId,
    token,
    graphVersion: env.metaGraphVersion || 'v25.0',
    datasetSource: source(Boolean(rowDataset), Boolean(envDataset)),
    tokenSource: source(Boolean(storedToken), Boolean(envToken)),
    tokenLast4: storedToken ? (row.token_last4 || storedToken.slice(-4)) : (envToken ? envToken.slice(-4) : ''),
    tokenStored: Boolean(storedToken),
    // A token is on the row but cannot be opened with this server's key.
    tokenUnreadable: Boolean(row?.token_encrypted) && !storedToken,
    updatedAt: row?.updated_at || null,
    updatedBy: row?.updated_by || null,
  };
}

/** Effective decrypted config for the server (DB over env). Cached briefly. */
async function getMetaCrmConfig() {
  const now = Date.now();
  if (settingsCache && now < settingsCacheExpiresAt) return settingsCache;
  const effective = resolveMetaCrmConfig(await getMetaCrmSettingsRow(), config);
  settingsCache = effective;
  settingsCacheExpiresAt = now + SETTINGS_CACHE_TTL_MS;
  return effective;
}

/** The admin view — everything but the token itself. */
function adminView(cfg) {
  return {
    enabled: cfg.enabled,
    configured: Boolean(cfg.datasetId && cfg.token),
    datasetId: cfg.datasetId || null,
    datasetSource: cfg.datasetSource,
    tokenSet: Boolean(cfg.token),
    tokenLast4: cfg.tokenLast4 || null,
    tokenSource: cfg.tokenSource,
    tokenUnreadable: cfg.tokenUnreadable,
    updatedAt: cfg.updatedAt,
    updatedBy: cfg.updatedBy,
  };
}

async function writeRow(sets, values) {
  // The migration seeds the row; this keeps a save working even if it was ever
  // removed by hand.
  await query('INSERT INTO meta_crm_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  await query(`UPDATE meta_crm_settings SET ${sets.join(', ')}, updated_at = NOW() WHERE id = 1`, values);
  invalidateMetaCrmSettingsCache();
}

/**
 * Store a tested configuration and switch the sync on. `token` empty keeps the
 * stored one. The caller (services/metaCrm/settingsService.js) has already
 * validated both values and proven them against Meta — this writes, nothing
 * more.
 */
async function saveMetaCrmSettings({ datasetId, token = '', updatedBy = null }) {
  const sets = ['dataset_id = $1', 'enabled = TRUE', 'updated_by = $2'];
  const values = [String(datasetId), updatedBy];
  if (token) {
    sets.push('token_encrypted = $3', 'token_last4 = $4');
    values.push(encryptText(token), String(token).slice(-4));
  }
  await writeRow(sets, values);
}

/** The ON/OFF switch. Off stops sending; nothing stored is removed. */
async function setMetaCrmEnabled(enabled, updatedBy = null) {
  await writeRow(['enabled = $1', 'updated_by = $2'], [enabled === true, updatedBy]);
}

module.exports = {
  invalidateMetaCrmSettingsCache,
  getMetaCrmSettingsRow,
  resolveMetaCrmConfig,
  getMetaCrmConfig,
  adminView,
  saveMetaCrmSettings,
  setMetaCrmEnabled,
};
