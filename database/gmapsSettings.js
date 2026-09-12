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
const { encryptText } = require('../lib/security/facebookCrypto');
const { maskKey, createSafeDecrypt } = require('../lib/security/secretMasking');

const CACHE_TTL_MS = 30_000;
let cache = null;
let cacheExpiresAt = 0;

function invalidateCache() {
  cache = null;
  cacheExpiresAt = 0;
}

const safeDecrypt = createSafeDecrypt('[GMAPS SETTINGS]', 'a stored key');

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
 * distinction that matters during an outage — route geometry and off-route warnings read as switched off.
 */
async function getSettingsRow() {
  const res = await query('SELECT * FROM gmaps_settings WHERE id = 1');
  return res.rows[0] || null;
}

function intOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

/** Float reader with an inclusive clamp — used for the completion radius (miles). */
function floatClamp(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Auto-complete radius (miles) around the final destination. The single
// authoritative default/range lives in lib/routeControl/routeControlConstants.js.
const { ROUTE_COMPLETION_RADIUS_MILES } = require('../lib/routeControl/routeControlConstants');
const COMPLETION_RADIUS_MIN = ROUTE_COMPLETION_RADIUS_MILES.MIN;
const COMPLETION_RADIUS_MAX = ROUTE_COMPLETION_RADIUS_MILES.MAX;
const COMPLETION_RADIUS_DEFAULT = ROUTE_COMPLETION_RADIUS_MILES.DEFAULT;

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
    routeCompletionRadiusMiles: floatClamp(
      row?.route_completion_radius_miles, COMPLETION_RADIUS_DEFAULT, COMPLETION_RADIUS_MIN, COMPLETION_RADIUS_MAX
    ),
    updatedAt: row?.updated_at || null,
  };

  cache = effective;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return effective;
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
    routeCompletionRadiusMiles: cfg.routeCompletionRadiusMiles,
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
  // Completion radius is a float, clamped to the DB CHECK range so a bad value
  // never fails the UPDATE. Omitted → left unchanged.
  if (payload.routeCompletionRadiusMiles !== undefined
      && payload.routeCompletionRadiusMiles !== null
      && payload.routeCompletionRadiusMiles !== '') {
    const n = Number(payload.routeCompletionRadiusMiles);
    if (Number.isFinite(n)) {
      sets.push(`route_completion_radius_miles = $${i++}`);
      values.push(Math.min(COMPLETION_RADIUS_MAX, Math.max(COMPLETION_RADIUS_MIN, n)));
    }
  }

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
