/**
 * RingCentral SETTINGS and account credentials — database helpers.
 *
 * The single settings row: encrypted RingCentral credentials (same AES-256-GCM
 * scheme as Facebook tokens and ELD keys) plus the recruiter KPI targets.
 *
 * SHARED MUTABLE STATE — this module is the sole owner of the settings cache.
 * Every writer of the row calls invalidateSettingsCache(), which is why the
 * cache and both writers live together here rather than beside the readers.
 * Admin reads mask the secrets; only getRcConfig() decrypts them.
 *
 * Split out of database/ringcentral.js, which re-exports every symbol here.
 */
const { query } = require('../pool');
const config = require('../../config/config');
const { encryptText } = require('../../lib/security/facebookCrypto');
const { safeDecrypt, maskKey } = require('./secrets');
const { DEFAULT_TARGET_TALK_SECONDS, formatTalkLabel } = require('./kpiMath');

const SETTINGS_CACHE_TTL_MS = 15_000;

let settingsCache = null;

let settingsCacheExpiresAt = 0;

function invalidateSettingsCache() {
  settingsCache = null;
  settingsCacheExpiresAt = 0;
}

async function getSettingsRow() {
  try {
    const res = await query('SELECT * FROM ringcentral_settings WHERE id = 1');
    return res.rows[0] || null;
  } catch (err) {
    console.warn('[RC] ringcentral_settings unavailable:', err.message);
    return null;
  }
}

/** Effective decrypted config for server use (DB over env). Cached briefly. */
async function getRcConfig() {
  const now = Date.now();
  if (settingsCache && now < settingsCacheExpiresAt) return settingsCache;

  const row = await getSettingsRow();
  const effective = {
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

  settingsCache = effective;
  settingsCacheExpiresAt = now + SETTINGS_CACHE_TTL_MS;
  return effective;
}

/** Masked view for the admin GET — never returns raw secrets. */
async function getRcSettingsForAdmin() {
  const row = await getSettingsRow();
  const cfg = await getRcConfig();
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

async function markSyncResult({ error = null } = {}) {
  await query(
    'UPDATE ringcentral_settings SET last_synced_at = NOW(), last_sync_error = $1 WHERE id = 1',
    [error ? String(error).slice(0, 500) : null]
  );
  invalidateSettingsCache();
}

module.exports = {
  invalidateSettingsCache,
  getSettingsRow,
  getRcConfig,
  getRcSettingsForAdmin,
  updateRcSettings,
  markSyncResult,
};
