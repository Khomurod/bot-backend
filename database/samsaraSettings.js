/**
 * SAMSARA operational settings — single-row store (id = 1).
 *
 * The admin panel's Samsara area writes this row; BOTH this app and the
 * separate `samsara-integration` poller read it over the shared database. It is
 * the reason an operator can change the API key, turn missing-video recovery
 * on or off, or move the initial re-check delay without touching Render.
 *
 * THREE RULES HOLD HERE.
 *
 * 1. **The environment is still a fallback, per value.** An empty column means
 *    "inherit the environment variable", so the currently deployed
 *    SAMSARA_API_KEY keeps working with nothing entered and nothing migrated.
 *    Only a saved value overrides it.
 *
 * 2. **The API key uses the SHARED envelope**, not
 *    `lib/security/facebookCrypto`, because the poller has to open it too and
 *    holds none of this app's secrets — see
 *    `lib/security/sharedIntegrationCrypto.js` for what that costs and why.
 *    `api_key_fingerprint` records which key material wrote it so a reader that
 *    cannot open it says so and falls back, rather than losing Samsara.
 *
 * 3. **A key is never returned raw and never logged.** Reads mask it; the
 *    connection test exercises it server-side. `api_key_last4` lets the panel
 *    mask a key even in the case where this process could not decrypt it.
 */
const { query } = require('./db');
const config = require('../config/config');
const sharedCrypto = require('../lib/security/sharedIntegrationCrypto');

// Read on the poller's and the resolver's behalf repeatedly; a short cache
// keeps a settings read off every event without making a change feel stuck.
const CACHE_TTL_MS = 30_000;
let cache = null;
let cacheExpiresAt = 0;

function invalidateCache() {
  cache = null;
  cacheExpiresAt = 0;
  // The live-location config folds the Samsara key and base in, and caches its
  // own copy for 30s. Lazy require because eldSettings depends on THIS module;
  // by the time a save runs, both are loaded.
  try {
    require('./eldSettings').invalidateCache();
  } catch (err) {
    console.warn('[SAMSARA SETTINGS] Could not refresh the ELD config cache:', err.message);
  }
}

const DEFAULT_API_BASE = 'https://api.samsara.com';

/**
 * The shipped defaults, in one place, so the admin API, the poller and the
 * migration cannot drift apart. Seconds everywhere — the UI converts.
 */
const DEFAULTS = {
  enabled: true,
  apiBase: DEFAULT_API_BASE,
  speedingEventsEnabled: true,
  maxVideoMegabytes: 25,
  videoRecoveryEnabled: true,
  videoRecoveryInitialDelaySeconds: 300,
  videoRetrievalEnabled: true,
  videoRecoveryRetryIntervalSeconds: 300,
  videoRecoveryMaxAttempts: 12,
  videoRetrievalWindowBeforeSeconds: 15,
  videoRetrievalWindowAfterSeconds: 45,
};

async function getSettingsRow() {
  try {
    const res = await query('SELECT * FROM samsara_settings WHERE id = 1');
    return res.rows[0] || null;
  } catch (err) {
    // The table may not exist yet on a database that has not run migration
    // 0013. Behaving as "nothing configured" keeps the env fallback working.
    console.warn('[SAMSARA SETTINGS] samsara_settings unavailable:', err.message);
    return null;
  }
}

function intOr(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** NULL is "not saved" and inherits; only a real boolean overrides. */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * The environment values these columns inherit when nothing is saved.
 *
 * They are the SAME variables the separate Samsara poller has always read, so
 * a deployment that sets one keeps it until an administrator saves over it in
 * the panel — which is the whole point of the columns being nullable.
 */
function envSpeedingEnabled() {
  const raw = process.env.SAMSARA_SPEEDING_ENABLED;
  return raw === undefined || raw === '' ? DEFAULTS.speedingEventsEnabled : raw !== 'false';
}

function envVideoRecoveryEnabled() {
  const raw = process.env.SAMSARA_VIDEO_RETRY_ENABLED;
  return raw === undefined || raw === '' ? DEFAULTS.videoRecoveryEnabled : raw !== 'false';
}

function envMaxVideoMegabytes() {
  const bytes = Number.parseInt(process.env.SAMSARA_MAX_VIDEO_BYTES || '0', 10);
  return Number.isFinite(bytes) && bytes > 0
    ? Math.max(1, Math.round(bytes / (1024 * 1024)))
    : DEFAULTS.maxVideoMegabytes;
}

function envInitialDelaySeconds() {
  const ms = Number.parseInt(process.env.SAMSARA_VIDEO_RETRY_DELAY_MS || '0', 10);
  return Number.isFinite(ms) && ms > 0
    ? Math.round(ms / 1000)
    : DEFAULTS.videoRecoveryInitialDelaySeconds;
}

/**
 * Effective, decrypted config for server-side use. Database wins; an empty
 * database value falls back to the environment. Cached for CACHE_TTL_MS.
 */
async function getSamsaraConfig() {
  const now = Date.now();
  if (cache && now < cacheExpiresAt) return cache;

  const row = await getSettingsRow();
  const storedKey = row?.api_key_encrypted
    ? sharedCrypto.safeDecryptShared(row.api_key_encrypted)
    : '';
  const envKey = config.samsaraApiKey || '';

  const effective = {
    enabled: row ? row.enabled !== false : DEFAULTS.enabled,
    apiKey: storedKey || envKey,
    apiKeySource: storedKey ? 'database' : (envKey ? 'environment' : 'none'),
    // A stored key this process could NOT open. The panel needs to know: it is
    // the difference between "nothing is saved" and "your key material changed".
    apiKeyUnreadable: Boolean(row?.api_key_encrypted) && !storedKey,
    apiKeyLast4: row?.api_key_last4 || (envKey ? envKey.slice(-4) : null),
    apiBase: (row?.api_base || config.samsaraApiBase || DEFAULT_API_BASE).replace(/\/+$/, ''),

    // NULL means "nothing saved — inherit the environment", which is why the
    // seeded row changes nothing. `bool`/`intOr` fall through on NULL; only a
    // value an administrator actually saved overrides the deployment.
    speedingEventsEnabled: bool(row?.speeding_events_enabled, envSpeedingEnabled()),
    maxVideoMegabytes: intOr(row?.max_video_megabytes, envMaxVideoMegabytes()),

    videoRecoveryEnabled: bool(row?.video_recovery_enabled, envVideoRecoveryEnabled()),
    videoRecoveryInitialDelaySeconds: intOr(
      row?.video_recovery_initial_delay_seconds, envInitialDelaySeconds()
    ),
    videoRetrievalEnabled: bool(row?.video_retrieval_enabled, DEFAULTS.videoRetrievalEnabled),
    videoRecoveryRetryIntervalSeconds: intOr(
      row?.video_recovery_retry_interval_seconds, DEFAULTS.videoRecoveryRetryIntervalSeconds
    ),
    videoRecoveryMaxAttempts: intOr(row?.video_recovery_max_attempts, DEFAULTS.videoRecoveryMaxAttempts),
    videoRetrievalWindowBeforeSeconds: intOr(
      row?.video_retrieval_window_before_seconds, DEFAULTS.videoRetrievalWindowBeforeSeconds
    ),
    videoRetrievalWindowAfterSeconds: intOr(
      row?.video_retrieval_window_after_seconds, DEFAULTS.videoRetrievalWindowAfterSeconds
    ),

    updatedAt: row?.updated_at || null,
    updatedBy: row?.updated_by || null,
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

/** Masked view for the admin GET — the key itself never leaves the server. */
async function getSamsaraSettingsForAdmin() {
  const cfg = await getSamsaraConfig();
  return {
    enabled: cfg.enabled,
    apiKeySet: Boolean(cfg.apiKey) || cfg.apiKeyUnreadable,
    apiKeyMasked: cfg.apiKey ? maskKey(cfg.apiKey) : (cfg.apiKeyLast4 ? `••••${cfg.apiKeyLast4}` : null),
    apiKeySource: cfg.apiKeySource,
    apiKeyFromEnv: cfg.apiKeySource === 'environment',
    apiKeyUnreadable: cfg.apiKeyUnreadable,
    apiBase: cfg.apiBase,

    speedingEventsEnabled: cfg.speedingEventsEnabled,
    maxVideoMegabytes: cfg.maxVideoMegabytes,

    videoRecoveryEnabled: cfg.videoRecoveryEnabled,
    videoRecoveryInitialDelaySeconds: cfg.videoRecoveryInitialDelaySeconds,
    videoRetrievalEnabled: cfg.videoRetrievalEnabled,
    videoRecoveryRetryIntervalSeconds: cfg.videoRecoveryRetryIntervalSeconds,
    videoRecoveryMaxAttempts: cfg.videoRecoveryMaxAttempts,
    videoRetrievalWindowBeforeSeconds: cfg.videoRetrievalWindowBeforeSeconds,
    videoRetrievalWindowAfterSeconds: cfg.videoRetrievalWindowAfterSeconds,

    // So the panel can be honest about which process will see the saved key.
    sharedSecretAvailable: sharedCrypto.isAvailable(),
    updatedAt: cfg.updatedAt,
    updatedBy: cfg.updatedBy,
  };
}

/** Clamp to the same bounds the CHECK constraints enforce, so a slider typo is a value, not a 500. */
function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const NUMERIC_FIELDS = [
  ['max_video_megabytes', 'maxVideoMegabytes', 1, 200],
  ['video_recovery_initial_delay_seconds', 'videoRecoveryInitialDelaySeconds', 30, 86400],
  ['video_recovery_retry_interval_seconds', 'videoRecoveryRetryIntervalSeconds', 30, 86400],
  ['video_recovery_max_attempts', 'videoRecoveryMaxAttempts', 1, 200],
  ['video_retrieval_window_before_seconds', 'videoRetrievalWindowBeforeSeconds', 0, 300],
  ['video_retrieval_window_after_seconds', 'videoRetrievalWindowAfterSeconds', 5, 300],
];

const BOOLEAN_FIELDS = [
  ['enabled', 'enabled'],
  ['speeding_events_enabled', 'speedingEventsEnabled'],
  ['video_recovery_enabled', 'videoRecoveryEnabled'],
  ['video_retrieval_enabled', 'videoRetrievalEnabled'],
];

/**
 * Update the row.
 *
 *   - a non-empty `apiKey` replaces the stored key
 *   - omitting `apiKey` leaves the stored key alone — THIS is what stops a
 *     "Save" of the recovery settings wiping the working credential
 *   - `clearApiKey: true` nulls it so the environment variable takes over again
 *
 * Nothing here logs a key, and nothing returns one.
 */
async function updateSamsaraSettings(payload = {}, { updatedBy = null } = {}) {
  // What the row holds now — the fallback when a numeric field arrives unparseable.
  const current = await getSamsaraConfig();
  const sets = [];
  const values = [];
  let i = 1;

  for (const [column, key] of BOOLEAN_FIELDS) {
    if (typeof payload[key] === 'boolean') {
      sets.push(`${column} = $${i++}`);
      values.push(payload[key]);
    }
  }

  for (const [column, key, min, max] of NUMERIC_FIELDS) {
    if (payload[key] === undefined || payload[key] === null || payload[key] === '') continue;
    sets.push(`${column} = $${i++}`);
    values.push(clampInt(payload[key], min, max, current[key]));
  }

  if (typeof payload.apiBase === 'string' && payload.apiBase.trim()) {
    sets.push(`api_base = $${i++}`);
    values.push(payload.apiBase.trim().replace(/\/+$/, ''));
  }

  if (payload.clearApiKey) {
    sets.push('api_key_encrypted = NULL', 'api_key_fingerprint = NULL', 'api_key_last4 = NULL');
  } else {
    const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
    if (apiKey) {
      sets.push(`api_key_encrypted = $${i++}`);
      values.push(sharedCrypto.encryptShared(apiKey));
      sets.push(`api_key_fingerprint = $${i++}`);
      values.push(sharedCrypto.fingerprint());
      sets.push(`api_key_last4 = $${i++}`);
      values.push(apiKey.slice(-4));
    }
  }

  if (!sets.length) {
    invalidateCache();
    return getSamsaraSettingsForAdmin();
  }

  sets.push(`updated_by = $${i++}`);
  values.push(updatedBy);
  sets.push('updated_at = NOW()');

  // The row is seeded by the migration; re-seed defensively so a database that
  // somehow lost it does not silently swallow every save.
  await query('INSERT INTO samsara_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  await query(`UPDATE samsara_settings SET ${sets.join(', ')} WHERE id = 1`, values);
  invalidateCache();
  return getSamsaraSettingsForAdmin();
}

module.exports = {
  DEFAULTS,
  DEFAULT_API_BASE,
  getSamsaraConfig,
  getSamsaraSettingsForAdmin,
  updateSamsaraSettings,
  invalidateCache,
  maskKey,
};
