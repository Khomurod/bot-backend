/**
 * ELD / live-location provider settings — single-row store (id = 1).
 *
 * Backs the admin panel's Settings tab. Samsara is the primary location source;
 * Factor ELD and Leader ELD (both on the shared Drive HoS platform) are the
 * fallbacks. Secrets are stored encrypted (AES-256-GCM, same scheme as Facebook
 * tokens) and decrypted only server-side. When a stored key is empty the
 * effective config falls back to the matching environment variable so the app
 * keeps working before anything is entered in the panel.
 */
const { query } = require('./db');
const config = require('../config/config');
const { encryptText, decryptText } = require('../services/facebookCrypto');

// The location resolver runs on a hot path (per group, repeatedly). Cache the
// decrypted effective config briefly so we don't hit the DB on every ping.
const CACHE_TTL_MS = 30_000;
let cache = null;
let cacheExpiresAt = 0;

function invalidateCache() {
  cache = null;
  cacheExpiresAt = 0;
}

function safeDecrypt(payload) {
  if (!payload) return '';
  try {
    return decryptText(payload);
  } catch (err) {
    console.warn('[ELD SETTINGS] Failed to decrypt a stored key:', err.message);
    return '';
  }
}

async function getSettingsRow() {
  try {
    const res = await query('SELECT * FROM eld_settings WHERE id = 1');
    return res.rows[0] || null;
  } catch (err) {
    // Table may not exist yet on a brand-new DB before initializeDatabase ran.
    console.warn('[ELD SETTINGS] eld_settings unavailable:', err.message);
    return null;
  }
}

/**
 * Effective, decrypted config for server-side use. DB values win; empty DB
 * values fall back to environment variables. Cached for CACHE_TTL_MS.
 */
async function getEldConfig() {
  const now = Date.now();
  if (cache && now < cacheExpiresAt) return cache;

  const row = await getSettingsRow();

  const envSamsaraKeys = Array.isArray(config.samsaraApiKeys) ? config.samsaraApiKeys : [];
  const dbSamsaraKey = safeDecrypt(row?.samsara_api_key_encrypted);
  const samsaraApiKeys = Array.from(new Set(
    [dbSamsaraKey, config.samsaraApiKey, ...envSamsaraKeys].filter(Boolean)
  ));

  const effective = {
    samsaraEnabled: row ? row.samsara_enabled !== false : true,
    samsaraApiKeys,
    samsaraApiBase: config.samsaraApiBase,

    driveHosApiBase: (row?.drivehos_api_base || config.driveHosApiBase || 'https://api.drivehos.app')
      .replace(/\/+$/, ''),
    driveHosProviderKey: safeDecrypt(row?.drivehos_provider_key_encrypted) || config.driveHosProviderKey || '',

    factorEnabled: row ? row.factor_enabled !== false : true,
    factorCompanyKey: safeDecrypt(row?.factor_company_key_encrypted) || config.factorEldCompanyKey || '',

    leaderEnabled: row ? row.leader_enabled !== false : true,
    leaderCompanyKey: safeDecrypt(row?.leader_company_key_encrypted) || config.leaderEldCompanyKey || '',
  };

  cache = effective;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return effective;
}

function maskKey(value) {
  const str = String(value || '');
  if (!str) return null;
  if (str.length <= 4) return `••••`;
  return `••••${str.slice(-4)}`;
}

/**
 * Masked view for the admin GET — never returns raw secrets, only whether each
 * key is set and its last 4 characters, plus the non-secret fields.
 */
async function getEldSettingsForAdmin() {
  const row = await getSettingsRow();
  const cfg = await getEldConfig();
  return {
    samsaraEnabled: cfg.samsaraEnabled,
    samsaraApiKeySet: Boolean(cfg.samsaraApiKeys.length),
    samsaraApiKeyMasked: maskKey(cfg.samsaraApiKeys[0]),
    samsaraFromEnv: !row?.samsara_api_key_encrypted && Boolean(cfg.samsaraApiKeys.length),

    driveHosApiBase: cfg.driveHosApiBase,
    driveHosProviderKeySet: Boolean(cfg.driveHosProviderKey),
    driveHosProviderKeyMasked: maskKey(cfg.driveHosProviderKey),
    driveHosProviderFromEnv: !row?.drivehos_provider_key_encrypted && Boolean(cfg.driveHosProviderKey),

    factorEnabled: cfg.factorEnabled,
    factorCompanyKeySet: Boolean(cfg.factorCompanyKey),
    factorCompanyKeyMasked: maskKey(cfg.factorCompanyKey),
    factorFromEnv: !row?.factor_company_key_encrypted && Boolean(cfg.factorCompanyKey),

    leaderEnabled: cfg.leaderEnabled,
    leaderCompanyKeySet: Boolean(cfg.leaderCompanyKey),
    leaderCompanyKeyMasked: maskKey(cfg.leaderCompanyKey),
    leaderFromEnv: !row?.leader_company_key_encrypted && Boolean(cfg.leaderCompanyKey),

    updatedAt: row?.updated_at || null,
  };
}

/**
 * Update settings. For each secret field:
 *   - a non-empty string is encrypted and stored
 *   - the field being omitted leaves the stored value unchanged
 *   - passing `{ clear: true }` (e.g. clearFactorCompanyKey) nulls it out so the
 *     env fallback (if any) takes over again
 * Boolean/plain fields are applied when present.
 */
async function updateEldSettings(payload = {}) {
  const sets = [];
  const values = [];
  let i = 1;

  const pushSecret = (column, rawValue, clearFlag) => {
    if (clearFlag) {
      sets.push(`${column} = NULL`);
      return;
    }
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (value) {
      sets.push(`${column} = $${i++}`);
      values.push(encryptText(value));
    }
  };

  const pushBool = (column, value) => {
    if (typeof value === 'boolean') {
      sets.push(`${column} = $${i++}`);
      values.push(value);
    }
  };

  pushBool('samsara_enabled', payload.samsaraEnabled);
  pushSecret('samsara_api_key_encrypted', payload.samsaraApiKey, payload.clearSamsaraApiKey);

  if (typeof payload.driveHosApiBase === 'string' && payload.driveHosApiBase.trim()) {
    sets.push(`drivehos_api_base = $${i++}`);
    values.push(payload.driveHosApiBase.trim().replace(/\/+$/, ''));
  }
  pushSecret('drivehos_provider_key_encrypted', payload.driveHosProviderKey, payload.clearDriveHosProviderKey);

  pushBool('factor_enabled', payload.factorEnabled);
  pushSecret('factor_company_key_encrypted', payload.factorCompanyKey, payload.clearFactorCompanyKey);

  pushBool('leader_enabled', payload.leaderEnabled);
  pushSecret('leader_company_key_encrypted', payload.leaderCompanyKey, payload.clearLeaderCompanyKey);

  if (!sets.length) {
    invalidateCache();
    return getEldSettingsForAdmin();
  }

  sets.push('updated_at = NOW()');
  await query(
    `UPDATE eld_settings SET ${sets.join(', ')} WHERE id = 1`,
    values
  );
  invalidateCache();
  return getEldSettingsForAdmin();
}

module.exports = {
  getEldConfig,
  getEldSettingsForAdmin,
  updateEldSettings,
  invalidateCache,
};
