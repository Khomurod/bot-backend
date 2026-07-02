/**
 * RingCentral recruiter-call KPIs — database helpers.
 *
 * Backs the admin Settings (credentials + targets) and the recruiter KPI
 * dashboard. Credentials are stored encrypted (same AES-256-GCM scheme as
 * Facebook tokens / ELD keys). Raw call records are stored so KPIs are always
 * recomputable; each poll upserts by RingCentral record id.
 */
const { DateTime } = require('luxon');
const { query } = require('./db');
const config = require('../config/config');
const { encryptText, decryptText } = require('../services/facebookCrypto');

const SETTINGS_CACHE_TTL_MS = 15_000;
let settingsCache = null;
let settingsCacheExpiresAt = 0;

function invalidateSettingsCache() {
  settingsCache = null;
  settingsCacheExpiresAt = 0;
}

function safeDecrypt(payload) {
  if (!payload) return '';
  try {
    return decryptText(payload);
  } catch (err) {
    console.warn('[RC] Failed to decrypt a stored credential:', err.message);
    return '';
  }
}

/** Digits-only, last-10 form so "+1 (470) 480-4679" == "4704804679". */
function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length > 10 ? digits.slice(-10) : digits;
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
    targetOutbound: row?.target_outbound ?? 150,
    targetRealConversations: row?.target_real_conversations ?? 35,
    lastSyncedAt: row?.last_synced_at || null,
    lastSyncError: row?.last_sync_error || null,
  };

  settingsCache = effective;
  settingsCacheExpiresAt = now + SETTINGS_CACHE_TTL_MS;
  return effective;
}

function maskKey(value) {
  const str = String(value || '');
  if (!str) return null;
  if (str.length <= 4) return '••••';
  return `••••${str.slice(-4)}`;
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

// ─── Recruiters ───

async function listRecruiters({ includeInactive = true } = {}) {
  const res = await query(
    `SELECT * FROM recruiters ${includeInactive ? '' : 'WHERE active = TRUE'} ORDER BY name ASC`
  );
  return res.rows;
}

async function createRecruiter({ name, phoneNumber, active = true }) {
  const normalized = normalizePhone(phoneNumber);
  if (!name || !String(name).trim()) throw new Error('Recruiter name is required.');
  if (!normalized) throw new Error('A valid phone number is required.');
  const res = await query(
    `INSERT INTO recruiters (name, phone_number, phone_number_normalized, active)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [String(name).trim(), String(phoneNumber).trim(), normalized, active !== false]
  );
  return res.rows[0];
}

async function updateRecruiter(id, { name, phoneNumber, active }) {
  const sets = [];
  const values = [];
  let i = 1;
  if (typeof name === 'string' && name.trim()) { sets.push(`name = $${i++}`); values.push(name.trim()); }
  if (typeof phoneNumber === 'string' && phoneNumber.trim()) {
    const normalized = normalizePhone(phoneNumber);
    if (!normalized) throw new Error('A valid phone number is required.');
    sets.push(`phone_number = $${i++}`); values.push(phoneNumber.trim());
    sets.push(`phone_number_normalized = $${i++}`); values.push(normalized);
  }
  if (typeof active === 'boolean') { sets.push(`active = $${i++}`); values.push(active); }
  if (!sets.length) {
    const cur = await query('SELECT * FROM recruiters WHERE id = $1', [id]);
    return cur.rows[0] || null;
  }
  sets.push('updated_at = NOW()');
  values.push(id);
  const res = await query(`UPDATE recruiters SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, values);
  return res.rows[0] || null;
}

async function deleteRecruiter(id) {
  await query('DELETE FROM recruiters WHERE id = $1', [id]);
}

async function getRecruiterByNormalizedNumber(normalized) {
  if (!normalized) return null;
  const res = await query('SELECT * FROM recruiters WHERE phone_number_normalized = $1', [normalized]);
  return res.rows[0] || null;
}

// ─── Calls ───

/** Upsert one call record; duration/result may finalize on a later poll. */
async function upsertCall(call) {
  await query(
    `INSERT INTO ringcentral_calls
       (id, session_id, recruiter_id, recruiter_number_normalized, direction, result,
        from_number, to_number, duration_seconds, call_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET
       session_id = EXCLUDED.session_id,
       recruiter_id = EXCLUDED.recruiter_id,
       recruiter_number_normalized = EXCLUDED.recruiter_number_normalized,
       direction = EXCLUDED.direction,
       result = EXCLUDED.result,
       from_number = EXCLUDED.from_number,
       to_number = EXCLUDED.to_number,
       duration_seconds = EXCLUDED.duration_seconds,
       call_time = EXCLUDED.call_time`,
    [
      String(call.id), call.sessionId || null, call.recruiterId || null,
      call.recruiterNumberNormalized || null, call.direction || null, call.result || null,
      call.fromNumber || null, call.toNumber || null,
      Number.isFinite(call.durationSeconds) ? call.durationSeconds : 0,
      call.callTime,
    ]
  );
}

/**
 * Per-recruiter KPI rollup for a single day (in the configured timezone).
 * Returns one entry per active recruiter (even those with zero calls) plus the
 * targets/thresholds used, so the dashboard can render progress vs target.
 */
async function getRecruiterStats(dateStr, cfg) {
  const tz = cfg.timezone || 'America/Chicago';
  const day = dateStr
    ? DateTime.fromISO(dateStr, { zone: tz })
    : DateTime.now().setZone(tz);
  const start = day.startOf('day');
  const end = start.plus({ days: 1 });
  const startUtc = start.toUTC().toISO();
  const endUtc = end.toUTC().toISO();

  const nonValuable = cfg.nonValuableMaxSeconds ?? 30;
  const realMin = cfg.realConversationMinSeconds ?? 60;
  const strongMin = cfg.strongConversationMinSeconds ?? 180;

  const res = await query(
    `SELECT
       r.id, r.name, r.phone_number, r.active,
       COUNT(c.id)::int AS total_calls,
       COUNT(c.id) FILTER (WHERE c.direction = 'Outbound')::int AS outbound,
       COUNT(c.id) FILTER (WHERE c.direction = 'Inbound')::int AS inbound,
       COUNT(c.id) FILTER (WHERE c.duration_seconds >= $4)::int AS real_conversations,
       COUNT(c.id) FILTER (WHERE c.duration_seconds >= $5)::int AS strong_conversations,
       COUNT(c.id) FILTER (WHERE c.duration_seconds > 0 AND c.duration_seconds < $3)::int AS non_valuable,
       COALESCE(SUM(c.duration_seconds), 0)::int AS total_talk_seconds
     FROM recruiters r
     LEFT JOIN ringcentral_calls c
       ON c.recruiter_id = r.id
      AND c.call_time >= $1 AND c.call_time < $2
     WHERE r.active = TRUE
     GROUP BY r.id
     ORDER BY r.name ASC`,
    [startUtc, endUtc, nonValuable, realMin, strongMin]
  );

  const targets = {
    outbound: cfg.targetOutbound ?? 150,
    realConversations: cfg.targetRealConversations ?? 35,
  };

  const recruiters = res.rows.map((row) => {
    const outboundPct = targets.outbound ? Math.min(100, Math.round((row.outbound / targets.outbound) * 100)) : 0;
    const realPct = targets.realConversations
      ? Math.min(100, Math.round((row.real_conversations / targets.realConversations) * 100)) : 0;
    return {
      id: row.id,
      name: row.name,
      phoneNumber: row.phone_number,
      totalCalls: row.total_calls,
      outbound: row.outbound,
      inbound: row.inbound,
      realConversations: row.real_conversations,
      strongConversations: row.strong_conversations,
      nonValuable: row.non_valuable,
      totalTalkSeconds: row.total_talk_seconds,
      outboundPct,
      realConversationsPct: realPct,
      outboundMet: row.outbound >= targets.outbound,
      realConversationsMet: row.real_conversations >= targets.realConversations,
      // 50/50 rule: 50% activity (outbound) + 50% conversion (real conversations)
      activityScore: Math.round(outboundPct / 2 + realPct / 2),
    };
  });

  return {
    date: start.toISODate(),
    timezone: tz,
    targets,
    thresholds: { nonValuableMaxSeconds: nonValuable, realConversationMinSeconds: realMin, strongConversationMinSeconds: strongMin },
    recruiters,
  };
}

module.exports = {
  normalizePhone,
  getRcConfig,
  getRcSettingsForAdmin,
  updateRcSettings,
  markSyncResult,
  invalidateSettingsCache,
  listRecruiters,
  createRecruiter,
  updateRecruiter,
  deleteRecruiter,
  getRecruiterByNormalizedNumber,
  upsertCall,
  getRecruiterStats,
};
