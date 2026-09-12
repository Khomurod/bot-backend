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
const { encryptText, decryptText } = require('../lib/security/facebookCrypto');
const samsaraSettings = require('./samsaraSettings');

// The location resolver runs on a hot path (per group, repeatedly). Cache the
// decrypted effective config briefly so we don't hit the DB on every ping.
const CACHE_TTL_MS = 30_000;
let cache = null;
let cacheExpiresAt = 0;

function invalidateCache() {
  cache = null;
  cacheExpiresAt = 0;
}

const DEFAULT_DRIVEHOS_API_BASE = 'https://api.drivehos.app';

/**
 * A Drive HoS API base URL that points at Swagger / interactive docs rather than
 * the actual API host. Live API calls against these fail, so we detect them,
 * refuse to use them for requests, and surface a clear warning in the admin UI.
 */
function looksLikeDocsUrl(url) {
  const s = String(url || '').toLowerCase();
  if (!s) return false;
  return s.includes('/swagger')
    || s.includes('/index.html')
    || s.includes('#')
    || s.includes('/api-docs')
    || s.includes('/redoc');
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

/**
 * The settings row, or a THROW.
 *
 * Deliberately not caught. A database that cannot be reached and a
 * configuration nobody has entered are opposite facts, and swallowing the first
 * turns it into the second. `APP_BRIEF.md` §9 states the rule — a failure is
 * never rendered as empty data — and `database/dispatchBoardSettings.js` is the
 * module that already reads this way.
 *
 * THIS USED TO CATCH EVERYTHING, on the stated grounds that "the table may not
 * exist yet on a brand-new database before initializeDatabase ran". That case
 * cannot occur: `initializeDatabase()` applies schema.sql and the migrations
 * before the server listens or the bot starts, and no boot path reads these
 * settings. So the catch was protecting against nothing, while costing the one
 * distinction that matters during an outage — the GPS provider chain silently shortens and a driver's location
 * comes back "unknown" instead of "could not look it up".
 */
async function getSettingsRow() {
  const res = await query('SELECT * FROM eld_settings WHERE id = 1');
  return res.rows[0] || null;
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
  // Settings → Samsara is the PRIMARY home for the Samsara credential now, and
  // it is the only one the separate samsara-integration poller can read. This
  // legacy column stays ahead of the environment so a key entered here before
  // the Samsara area existed keeps working untouched.
  const samsaraCfg = await samsaraSettings.getSamsaraConfig();
  const sharedSamsaraKey = samsaraCfg.apiKeySource === 'database' ? samsaraCfg.apiKey : '';
  const dbSamsaraKey = safeDecrypt(row?.samsara_api_key_encrypted);
  const samsaraApiKeys = Array.from(new Set(
    [sharedSamsaraKey, dbSamsaraKey, config.samsaraApiKey, ...envSamsaraKeys].filter(Boolean)
  ));

  const effective = {
    samsaraEnabled: (row ? row.samsara_enabled !== false : true) && samsaraCfg.enabled,
    samsaraApiKeys,
    samsaraApiBase: samsaraCfg.apiBase,

    // What the operator configured (DB row → env → default), used for display.
    driveHosApiBaseConfigured: (row?.drivehos_api_base || config.driveHosApiBase || DEFAULT_DRIVEHOS_API_BASE)
      .replace(/\/+$/, ''),
    // What we actually call: never a Swagger/docs URL — fall back to the real
    // API host so a mis-pasted documentation URL cannot silently break lookups.
    driveHosApiBase: (() => {
      const configured = (row?.drivehos_api_base || config.driveHosApiBase || DEFAULT_DRIVEHOS_API_BASE)
        .replace(/\/+$/, '');
      return looksLikeDocsUrl(configured) ? DEFAULT_DRIVEHOS_API_BASE : configured;
    })(),
    driveHosApiBaseLooksLikeDocs: looksLikeDocsUrl(row?.drivehos_api_base || config.driveHosApiBase || ''),
    driveHosProviderKey: safeDecrypt(row?.drivehos_provider_key_encrypted) || config.driveHosProviderKey || '',
    // Where the effective Samsara key came from, for the admin view.
    samsaraApiKeySource: (() => {
      if (sharedSamsaraKey) return 'samsara_settings';
      if (dbSamsaraKey) return 'legacy_eld_settings';
      return samsaraApiKeys.length ? 'environment' : 'none';
    })(),

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
    samsaraFromEnv: cfg.samsaraApiKeySource === 'environment',
    // The Samsara credential is managed under Settings → Samsara; this tab
    // shows it read-only so two pages cannot disagree about which key is live.
    samsaraApiKeySource: cfg.samsaraApiKeySource,

    driveHosApiBase: cfg.driveHosApiBaseConfigured,
    driveHosApiBaseLooksLikeDocs: cfg.driveHosApiBaseLooksLikeDocs,
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
  // A Samsara key entered on THIS tab is written to samsara_settings, not here:
  // the poller can only read that one, and two stores for one credential is how
  // the panel and the poller end up using different keys. The legacy column is
  // still read (above) and still clearable, so nothing already stored is lost.
  const samsaraKeyInput = typeof payload.samsaraApiKey === 'string' ? payload.samsaraApiKey.trim() : '';
  if (samsaraKeyInput || payload.clearSamsaraApiKey) {
    await samsaraSettings.updateSamsaraSettings({
      apiKey: samsaraKeyInput || undefined,
      clearApiKey: Boolean(payload.clearSamsaraApiKey),
    });
    if (payload.clearSamsaraApiKey) sets.push('samsara_api_key_encrypted = NULL');
  }

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

/**
 * The Drive HoS fallback providers, in the order every consumer tries them:
 * Factor ELD, then Leader ELD.
 *
 * WHY IT IS A FUNCTION AND NOT A LIST AT EACH CALL SITE. This literal was
 * written out identically in services/liveLocationResolver.js (the per-driver
 * lookup behind /location and ETA) and in the Dispatch Center's provider
 * diagnostics, which has since been removed. Two copies of "which providers
 * exist and in what order" is how a newly added provider ends up visible in one
 * place and invisible to the dispatcher typing /location — the second copy is
 * gone, and this stays a function so a third cannot start. Pure derivation from
 * the config object — no I/O, no caching of its own.
 *
 * @param {object} cfg the object returned by getEldConfig()
 * @returns {Array<{label: string, enabled: boolean, companyKey: string}>}
 */
function driveHosProvidersFrom(cfg) {
  return [
    { label: 'Factor ELD', enabled: Boolean(cfg?.factorEnabled), companyKey: cfg?.factorCompanyKey },
    { label: 'Leader ELD', enabled: Boolean(cfg?.leaderEnabled), companyKey: cfg?.leaderCompanyKey },
  ];
}

module.exports = {
  getEldConfig,
  driveHosProvidersFrom,
  getEldSettingsForAdmin,
  updateEldSettings,
  invalidateCache,
  looksLikeDocsUrl,
  DEFAULT_DRIVEHOS_API_BASE,
};
