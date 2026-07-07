/**
 * Google Maps Platform settings — single-row store (id = 1).
 *
 * Backs Settings → GMaps. The server API key is a secret: stored encrypted
 * (AES-256-GCM, same scheme as the ELD / RingCentral / Facebook credentials)
 * and NEVER returned to the frontend — the admin GET only reports whether a key
 * is set plus its masked last-4. When the stored key is empty the effective
 * config falls back to the GOOGLE_MAPS_API_KEY environment variable so nothing
 * breaks before a key is entered in the panel.
 */
const { query } = require('./db');
const config = require('../config/config');
const { encryptText, decryptText } = require('../services/facebookCrypto');

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
    console.warn('[GMAPS SETTINGS] Failed to decrypt a stored key:', err.message);
    return '';
  }
}

async function getSettingsRow() {
  try {
    const res = await query('SELECT * FROM gmaps_settings WHERE id = 1');
    return res.rows[0] || null;
  } catch (err) {
    console.warn('[GMAPS SETTINGS] gmaps_settings unavailable:', err.message);
    return null;
  }
}

function intOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

/**
 * Effective, decrypted config for server-side use. DB values win; an empty DB
 * key falls back to GOOGLE_MAPS_API_KEY. Cached for CACHE_TTL_MS.
 */
async function getGmapsConfig() {
  const now = Date.now();
  if (cache && now < cacheExpiresAt) return cache;

  const row = await getSettingsRow();
  const dbServerKey = safeDecrypt(row?.server_api_key_encrypted);
  const serverApiKey = dbServerKey || config.googleMapsApiKey || '';
  const geocodingKey = safeDecrypt(row?.geocoding_api_key_encrypted) || serverApiKey;

  const effective = {
    enabled: row ? row.enabled === true : false,
    serverApiKey,
    serverApiKeyFromEnv: !dbServerKey && Boolean(serverApiKey),
    routesApiEnabled: row ? row.routes_api_enabled !== false : true,
    roadsApiEnabled: row ? row.roads_api_enabled === true : false,
    geocodingApiEnabled: row ? row.geocoding_api_enabled === true : false,
    geocodingApiKey: geocodingKey,
    deviationThresholdMeters: intOr(row?.deviation_threshold_meters, 250),
    checkIntervalSeconds: intOr(row?.check_interval_seconds, 300),
    offRouteGraceChecks: intOr(row?.off_route_grace_checks, 3),
    warningCooldownMinutes: intOr(row?.warning_cooldown_minutes, 30),
    staleGpsMinutes: intOr(row?.stale_gps_minutes, 15),
    parkedSpeedMph: intOr(row?.parked_speed_mph, 5),
    updatedAt: row?.updated_at || null,
  };

  cache = effective;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return effective;
}

function maskKey(value) {
  const str = String(value || '');
  if (!str) return null;
  if (str.length <= 4) return '••••';
  return `••••${str.slice(-4)}`;
}

/** Masked admin view — never returns the raw key. */
async function getGmapsSettingsForAdmin() {
  const cfg = await getGmapsConfig();
  const row = await getSettingsRow();
  return {
    enabled: cfg.enabled,
    serverApiKeySet: Boolean(cfg.serverApiKey),
    serverApiKeyMasked: maskKey(cfg.serverApiKey),
    serverApiKeyFromEnv: cfg.serverApiKeyFromEnv,
    routesApiEnabled: cfg.routesApiEnabled,
    roadsApiEnabled: cfg.roadsApiEnabled,
    geocodingApiEnabled: cfg.geocodingApiEnabled,
    geocodingApiKeySet: Boolean(row?.geocoding_api_key_encrypted),
    geocodingApiKeyMasked: maskKey(safeDecrypt(row?.geocoding_api_key_encrypted)),
    deviationThresholdMeters: cfg.deviationThresholdMeters,
    checkIntervalSeconds: cfg.checkIntervalSeconds,
    offRouteGraceChecks: cfg.offRouteGraceChecks,
    warningCooldownMinutes: cfg.warningCooldownMinutes,
    staleGpsMinutes: cfg.staleGpsMinutes,
    parkedSpeedMph: cfg.parkedSpeedMph,
    updatedAt: cfg.updatedAt,
  };
}

/**
 * Update settings. Secret fields: a non-empty string is encrypted+stored; an
 * omitted field is left unchanged; a `clear*` flag nulls it out. Boolean/numeric
 * fields are applied when present.
 */
async function updateGmapsSettings(payload = {}) {
  const sets = [];
  const values = [];
  let i = 1;

  const pushSecret = (column, rawValue, clearFlag) => {
    if (clearFlag) { sets.push(`${column} = NULL`); return; }
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (value) { sets.push(`${column} = $${i++}`); values.push(encryptText(value)); }
  };
  const pushBool = (column, value) => {
    if (typeof value === 'boolean') { sets.push(`${column} = $${i++}`); values.push(value); }
  };
  const pushInt = (column, value) => {
    if (value === undefined || value === null || value === '') return;
    const n = Number(value);
    if (Number.isFinite(n)) { sets.push(`${column} = $${i++}`); values.push(Math.round(n)); }
  };

  pushBool('enabled', payload.enabled);
  pushSecret('server_api_key_encrypted', payload.serverApiKey, payload.clearServerApiKey);
  pushBool('routes_api_enabled', payload.routesApiEnabled);
  pushBool('roads_api_enabled', payload.roadsApiEnabled);
  pushBool('geocoding_api_enabled', payload.geocodingApiEnabled);
  pushSecret('geocoding_api_key_encrypted', payload.geocodingApiKey, payload.clearGeocodingApiKey);
  pushInt('deviation_threshold_meters', payload.deviationThresholdMeters);
  pushInt('check_interval_seconds', payload.checkIntervalSeconds);
  pushInt('off_route_grace_checks', payload.offRouteGraceChecks);
  pushInt('warning_cooldown_minutes', payload.warningCooldownMinutes);
  pushInt('stale_gps_minutes', payload.staleGpsMinutes);
  pushInt('parked_speed_mph', payload.parkedSpeedMph);

  if (!sets.length) {
    invalidateCache();
    return getGmapsSettingsForAdmin();
  }
  sets.push('updated_at = NOW()');
  await query(`UPDATE gmaps_settings SET ${sets.join(', ')} WHERE id = 1`, values);
  invalidateCache();
  return getGmapsSettingsForAdmin();
}

module.exports = {
  getGmapsConfig,
  getGmapsSettingsForAdmin,
  updateGmapsSettings,
  invalidateCache,
};
