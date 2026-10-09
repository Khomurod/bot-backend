/**
 * RingCentral SETTINGS and account credentials — database helpers.
 *
 * The single settings row: encrypted RingCentral credentials (same AES-256-GCM
 * scheme as Facebook tokens and ELD keys) plus the recruiter KPI targets.
 *
 * SHARED MUTABLE STATE — this module is the sole owner of the settings cache.
 * Both writers of the row live here: the admin save invalidates the cache (and,
 * through it, the public leaderboard, whose targets and "today" come from this
 * row); the sync's own stamp refreshes the cached copy in place.
 * Admin reads mask the secrets; only getRcConfig() decrypts them.
 *
 * KEPT UNTIL IT CHANGES (October 2026, when the hosted database's monthly
 * transfer allowance was nearly spent). The cache used to last 15 seconds, so
 * the call sync (every 10 minutes) and the public leaderboard (every 60
 * seconds) read the whole row on nearly every pass — the sync twice, because
 * its own stamp threw the cached copy away. Now the cached copy lives
 * SETTINGS_CACHE_TTL_MS, longer than a sync interval, because every save in
 * this process clears it; the TTL only bounds a save made by another instance
 * during a deploy. A FAILED read is still cached for the old 15 seconds only,
 * so a database blip cannot read as "RingCentral is off" for half an hour.
 *
 * Split out of database/ringcentral.js, which re-exports every symbol here.
 */
const { query } = require('../pool');
const config = require('../../config/config');
const { encryptText } = require('../../lib/security/facebookCrypto');
const { safeDecrypt, maskKey } = require('./secrets');
const { DEFAULT_TARGET_TALK_SECONDS, formatTalkLabel } = require('./kpiMath');
const { invalidateLeaderboardCache } = require('./leaderboardCache');

const SETTINGS_CACHE_TTL_MS = 30 * 60 * 1000;
const FAILED_READ_TTL_MS = 15_000;

/** Every column this module reads — by name, so a column added later is not read on every load. */
const SETTINGS_COLUMNS = [
  'enabled', 'api_base', 'client_id_encrypted', 'client_secret_encrypted', 'jwt_token_encrypted',
  'poll_minutes', 'timezone', 'non_valuable_max_seconds', 'real_conversation_min_seconds',
  'strong_conversation_min_seconds', 'target_talk_seconds', 'target_outbound', 'target_real_conversations',
  'last_synced_at', 'last_sync_error', 'updated_at',
].join(', ');

let settingsCache = null;

let settingsCacheExpiresAt = 0;

/**
 * Bumped by every invalidation, so a read that started before a save cannot
 * put the pre-save row back into the cache when it finishes.
 */
let settingsGeneration = 0;

function invalidateSettingsCache() {
  settingsCache = null;
  settingsCacheExpiresAt = 0;
  settingsGeneration += 1;
  invalidateLeaderboardCache();
}

function rememberSettings(effective, generation, now, ttlMs) {
  if (generation !== settingsGeneration) return;
  settingsCache = effective;
  settingsCacheExpiresAt = now + ttlMs;
}

/** The row, or null when there is none. Throws when the database does. */
async function readSettingsRow() {
  const res = await query(`SELECT ${SETTINGS_COLUMNS} FROM ringcentral_settings WHERE id = 1`);
  return res.rows[0] || null;
}

async function getSettingsRow() {
  try {
    return await readSettingsRow();
  } catch (err) {
    console.warn('[RC] ringcentral_settings unavailable:', err.message);
    return null;
  }
}

/** Effective decrypted config for server use (DB over env). Cached until it changes. */
async function getRcConfig() {
  const now = Date.now();
  if (settingsCache && now < settingsCacheExpiresAt) return settingsCache;

  const generation = settingsGeneration;
  let row = null;
  let failed = false;
  try {
    row = await readSettingsRow();
  } catch (err) {
    console.warn('[RC] ringcentral_settings unavailable:', err.message);
    failed = true;
  }
  const effective = buildRcConfig(row);
  rememberSettings(effective, generation, now, failed ? FAILED_READ_TTL_MS : SETTINGS_CACHE_TTL_MS);
  return effective;
}

/** The effective configuration one stored row describes (DB over env). Pure. */
function buildRcConfig(row) {
  return {
    enabled: row ? row.enabled === true : false,
    apiBase: (row?.api_base || 'https://platform.ringcentral.com').replace(/\/+$/, ''),
    clientId: safeDecrypt(row?.client_id_encrypted) || config.rcClientId || '',
    clientSecret: safeDecrypt(row?.client_secret_encrypted) || config.rcClientSecret || '',
    jwtToken: safeDecrypt(row?.jwt_token_encrypted) || config.rcJwtToken || '',
    pollMinutes: row?.poll_minutes || 10,
    timezone: row?.timezone || 'America/Chicago',
    nonValuableMaxSeconds: row?.non_valuable_max_seconds ?? 30,
    realConversationMinSeconds: row?.real_conversation_min_seconds ?? 60,
    strongConversationMinSeconds: row?.strong_conversation_min_seconds ?? 180,
    targetTalkSeconds: row?.target_talk_seconds ?? DEFAULT_TARGET_TALK_SECONDS,
    targetOutbound: row?.target_outbound ?? 150,
    targetRealConversations: row?.target_real_conversations ?? 35,
    lastSyncedAt: row?.last_synced_at || null,
    lastSyncError: row?.last_sync_error || null,
  };
}

/**
 * Masked view for the admin GET — never returns raw secrets.
 *
 * Built from the row it has just read, so the panel always shows what is
 * stored (including the database's own last-sync time), and that read refills
 * the cache. Only when the read fails does it fall back to the cached copy, as
 * it always did.
 */
async function getRcSettingsForAdmin() {
  const now = Date.now();
  const generation = settingsGeneration;
  const row = await getSettingsRow();
  let cfg;
  if (row) {
    cfg = buildRcConfig(row);
    rememberSettings(cfg, generation, now, SETTINGS_CACHE_TTL_MS);
  } else {
    cfg = await getRcConfig();
  }
  return {
    enabled: cfg.enabled,
    apiBase: cfg.apiBase,
    clientIdSet: Boolean(cfg.clientId),
    clientIdMasked: maskKey(cfg.clientId),
    clientSecretSet: Boolean(cfg.clientSecret),
    clientSecretMasked: maskKey(cfg.clientSecret),
    jwtTokenSet: Boolean(cfg.jwtToken),
    jwtTokenMasked: maskKey(cfg.jwtToken),
    fromEnv: {
      clientId: !row?.client_id_encrypted && Boolean(cfg.clientId),
      clientSecret: !row?.client_secret_encrypted && Boolean(cfg.clientSecret),
      jwtToken: !row?.jwt_token_encrypted && Boolean(cfg.jwtToken),
    },
    pollMinutes: cfg.pollMinutes,
    timezone: cfg.timezone,
    nonValuableMaxSeconds: cfg.nonValuableMaxSeconds,
    realConversationMinSeconds: cfg.realConversationMinSeconds,
    strongConversationMinSeconds: cfg.strongConversationMinSeconds,
    targetTalkSeconds: cfg.targetTalkSeconds,
    targetTalkMinutes: Math.round(cfg.targetTalkSeconds / 60),
    targetTalkLabel: formatTalkLabel(cfg.targetTalkSeconds),
    targetOutbound: cfg.targetOutbound,
    targetRealConversations: cfg.targetRealConversations,
    lastSyncedAt: cfg.lastSyncedAt,
    lastSyncError: cfg.lastSyncError,
    updatedAt: row?.updated_at || null,
  };
}

async function updateRcSettings(payload = {}) {
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
  const pushInt = (column, value, min, max) => {
    if (value === undefined || value === null || value === '') return;
    const num = Number.parseInt(value, 10);
    if (!Number.isFinite(num)) return;
    const clamped = Math.min(max, Math.max(min, num));
    sets.push(`${column} = $${i++}`); values.push(clamped);
  };
  const pushText = (column, value) => {
    if (typeof value === 'string' && value.trim()) { sets.push(`${column} = $${i++}`); values.push(value.trim()); }
  };

  pushBool('enabled', payload.enabled);
  if (typeof payload.apiBase === 'string' && payload.apiBase.trim()) {
    sets.push(`api_base = $${i++}`); values.push(payload.apiBase.trim().replace(/\/+$/, ''));
  }
  pushSecret('client_id_encrypted', payload.clientId, payload.clearClientId);
  pushSecret('client_secret_encrypted', payload.clientSecret, payload.clearClientSecret);
  pushSecret('jwt_token_encrypted', payload.jwtToken, payload.clearJwtToken);
  pushInt('poll_minutes', payload.pollMinutes, 1, 1440);
  pushText('timezone', payload.timezone);
  pushInt('non_valuable_max_seconds', payload.nonValuableMaxSeconds, 1, 3600);
  pushInt('real_conversation_min_seconds', payload.realConversationMinSeconds, 1, 3600);
  pushInt('strong_conversation_min_seconds', payload.strongConversationMinSeconds, 1, 3600);
  // Daily real-talk-time target; accepted in seconds, or minutes (converted).
  if (payload.targetTalkSeconds !== undefined && payload.targetTalkSeconds !== null && payload.targetTalkSeconds !== '') {
    pushInt('target_talk_seconds', payload.targetTalkSeconds, 60, 86400);
  } else if (payload.targetTalkMinutes !== undefined && payload.targetTalkMinutes !== null && payload.targetTalkMinutes !== '') {
    const minutes = Number.parseInt(payload.targetTalkMinutes, 10);
    if (Number.isFinite(minutes)) pushInt('target_talk_seconds', minutes * 60, 60, 86400);
  }
  pushInt('target_outbound', payload.targetOutbound, 0, 100000);
  pushInt('target_real_conversations', payload.targetRealConversations, 0, 100000);

  if (sets.length) {
    sets.push('updated_at = NOW()');
    await query(`UPDATE ringcentral_settings SET ${sets.join(', ')} WHERE id = 1`, values);
  }
  invalidateSettingsCache();
  return getRcSettingsForAdmin();
}

/**
 * The sync's own stamp. It changes no configuration, so the cached copy is
 * updated in place rather than thrown away — throwing it away is what made
 * every pass read the whole row a second time. The cached `lastSyncedAt` is
 * this process's clock at the write; the admin view reads the stored value.
 */
async function markSyncResult({ error = null } = {}) {
  const lastSyncError = error ? String(error).slice(0, 500) : null;
  await query(
    'UPDATE ringcentral_settings SET last_synced_at = NOW(), last_sync_error = $1 WHERE id = 1',
    [lastSyncError]
  );
  if (settingsCache) settingsCache = { ...settingsCache, lastSyncedAt: new Date(), lastSyncError };
}

module.exports = {
  invalidateSettingsCache,
  getSettingsRow,
  getRcConfig,
  getRcSettingsForAdmin,
  updateRcSettings,
  markSyncResult,
};
