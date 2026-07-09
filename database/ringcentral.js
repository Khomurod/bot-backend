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

// Main daily KPI: 2h 30m of REAL call duration per recruiter (calls shorter
// than nonValuableMaxSeconds — 30s by default — do not count toward it).
const DEFAULT_TARGET_TALK_SECONDS = 9000;

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

// ─── Recruiters ───

async function listRecruiters({ includeInactive = true } = {}) {
  const res = await query(
    `SELECT * FROM recruiters ${includeInactive ? '' : 'WHERE active = TRUE'} ORDER BY name ASC`
  );
  return res.rows;
}

async function getRecruiterById(id) {
  const res = await query('SELECT * FROM recruiters WHERE id = $1', [id]);
  return res.rows[0] || null;
}

/**
 * Resolve the effective RingCentral auth for one recruiter's number.
 * JWT is always the recruiter's own (JWTs are per-user). Client ID/Secret use
 * the recruiter's custom pair when stored, otherwise the shared pair from
 * ringcentral_settings / env.
 */
function resolveRecruiterRcAuth(recruiter, globalCfg) {
  const customClientId = safeDecrypt(recruiter?.client_id_encrypted);
  const customClientSecret = safeDecrypt(recruiter?.client_secret_encrypted);
  const usesCustomClient = Boolean(customClientId || customClientSecret);
  return {
    apiBase: globalCfg.apiBase,
    clientId: customClientId || globalCfg.clientId || '',
    clientSecret: customClientSecret || globalCfg.clientSecret || '',
    jwtToken: safeDecrypt(recruiter?.jwt_token_encrypted) || '',
    usesCustomClient,
  };
}

/** Masked recruiter view for the admin UI — secrets never returned raw. */
function toAdminRecruiter(row) {
  const jwt = safeDecrypt(row.jwt_token_encrypted);
  const clientId = safeDecrypt(row.client_id_encrypted);
  const clientSecret = safeDecrypt(row.client_secret_encrypted);
  return {
    id: row.id,
    name: row.name,
    phone_number: row.phone_number,
    active: row.active,
    jwtTokenSet: Boolean(jwt),
    jwtTokenMasked: maskKey(jwt),
    usesCustomClient: Boolean(clientId || clientSecret),
    clientIdSet: Boolean(clientId),
    clientIdMasked: maskKey(clientId),
    clientSecretSet: Boolean(clientSecret),
    clientSecretMasked: maskKey(clientSecret),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listRecruitersForAdmin({ includeInactive = true } = {}) {
  const rows = await listRecruiters({ includeInactive });
  return rows.map(toAdminRecruiter);
}

/** Build the SET fragments for the per-recruiter secret columns. */
function recruiterSecretSets({ jwtToken, clientId, clientSecret, clearJwtToken, clearClientCreds }, sets, values, startIndex) {
  let i = startIndex;
  const pushSecret = (column, rawValue, clearFlag) => {
    if (clearFlag) { sets.push(`${column} = NULL`); return; }
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (value) { sets.push(`${column} = $${i++}`); values.push(encryptText(value)); }
  };
  pushSecret('jwt_token_encrypted', jwtToken, clearJwtToken);
  pushSecret('client_id_encrypted', clientId, clearClientCreds);
  pushSecret('client_secret_encrypted', clientSecret, clearClientCreds);
  return i;
}

async function createRecruiter({ name, phoneNumber, active = true, jwtToken, clientId, clientSecret }) {
  const normalized = normalizePhone(phoneNumber);
  if (!name || !String(name).trim()) throw new Error('Recruiter name is required.');
  if (!normalized) throw new Error('A valid phone number is required.');
  const res = await query(
    `INSERT INTO recruiters
       (name, phone_number, phone_number_normalized, active,
        jwt_token_encrypted, client_id_encrypted, client_secret_encrypted)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      String(name).trim(), String(phoneNumber).trim(), normalized, active !== false,
      jwtToken && String(jwtToken).trim() ? encryptText(String(jwtToken).trim()) : null,
      clientId && String(clientId).trim() ? encryptText(String(clientId).trim()) : null,
      clientSecret && String(clientSecret).trim() ? encryptText(String(clientSecret).trim()) : null,
    ]
  );
  return toAdminRecruiter(res.rows[0]);
}

async function updateRecruiter(id, payload = {}) {
  const { name, phoneNumber, active } = payload;
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
  i = recruiterSecretSets(payload, sets, values, i);
  if (!sets.length) {
    const cur = await getRecruiterById(id);
    return cur ? toAdminRecruiter(cur) : null;
  }
  sets.push('updated_at = NOW()');
  values.push(id);
  const res = await query(`UPDATE recruiters SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, values);
  return res.rows[0] ? toAdminRecruiter(res.rows[0]) : null;
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

// ─── KPI math (pure, unit-tested) ───

/** "2h 30m" / "45m" style label for a number of seconds. */
function formatTalkLabel(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** Effective KPI thresholds (seconds) from the settings row / defaults. */
function resolveThresholds(cfg = {}) {
  return {
    nonValuableMaxSeconds: cfg.nonValuableMaxSeconds ?? 30,
    realConversationMinSeconds: cfg.realConversationMinSeconds ?? 60,
    strongConversationMinSeconds: cfg.strongConversationMinSeconds ?? 180,
  };
}

/**
 * Targets for a reporting window. Per-day targets scale linearly with the
 * number of days (e.g. a 3-day range → 3 × 2h30m talk time, 3 × 150 outbound).
 */
function buildTargets(cfg = {}, rangeDays = 1) {
  const days = Math.max(1, Math.floor(Number(rangeDays) || 1));
  const talkSeconds = (cfg.targetTalkSeconds ?? DEFAULT_TARGET_TALK_SECONDS) * days;
  return {
    talkSeconds,
    talkMinutes: Math.round(talkSeconds / 60),
    talkLabel: formatTalkLabel(talkSeconds),
    outbound: (cfg.targetOutbound ?? 150) * days,
    realConversations: (cfg.targetRealConversations ?? 35) * days,
  };
}

/**
 * Aggregate a recruiter's calls into raw KPI totals.
 *
 * The main-KPI rule lives here: a call counts toward valuableTalkSeconds ONLY
 * when duration_seconds >= nonValuableMaxSeconds (default 30s). Shorter
 * non-zero calls are tallied separately as non-valuable. totalTalkSeconds
 * still includes everything, but is never the main KPI.
 */
function summarizeCalls(calls = [], thresholds = resolveThresholds()) {
  const totals = {
    totalCalls: 0,
    outbound: 0,
    inbound: 0,
    realConversations: 0,
    strongConversations: 0,
    nonValuableCalls: 0,
    nonValuableSeconds: 0,
    totalTalkSeconds: 0,
    valuableTalkSeconds: 0,
  };
  for (const call of calls) {
    if (!call) continue;
    totals.totalCalls += 1;
    if (call.direction === 'Outbound') totals.outbound += 1;
    else if (call.direction === 'Inbound') totals.inbound += 1;
    const d = Math.max(0, Number(call.durationSeconds ?? call.duration_seconds) || 0);
    totals.totalTalkSeconds += d;
    if (d >= thresholds.nonValuableMaxSeconds) {
      totals.valuableTalkSeconds += d;
    } else if (d > 0) {
      totals.nonValuableCalls += 1;
      totals.nonValuableSeconds += d;
    }
    if (d >= thresholds.realConversationMinSeconds) totals.realConversations += 1;
    if (d >= thresholds.strongConversationMinSeconds) totals.strongConversations += 1;
  }
  return totals;
}

/**
 * Score one recruiter's totals against the window targets.
 *
 * Main score = 70% real-talk-time progress + 30% outbound progress. The old
 * 50/50 (outbound + real conversations) score is retired; activityScore is
 * kept as an alias of mainScore for backward compatibility.
 */
function computeRecruiterKpis(totals, targets) {
  const talkPct = targets.talkSeconds
    ? Math.min(100, Math.round((totals.valuableTalkSeconds / targets.talkSeconds) * 100)) : 0;
  const outboundPct = targets.outbound
    ? Math.min(100, Math.round((totals.outbound / targets.outbound) * 100)) : 0;
  const realPct = targets.realConversations
    ? Math.min(100, Math.round((totals.realConversations / targets.realConversations) * 100)) : 0;
  const mainScore = Math.round(talkPct * 0.7 + outboundPct * 0.3);
  return {
    ...totals,
    // Back-compat alias: earlier payloads called the short-call count "nonValuable".
    nonValuable: totals.nonValuableCalls,
    talkPct,
    talkMet: totals.valuableTalkSeconds >= targets.talkSeconds,
    talkRemainingSeconds: Math.max(0, targets.talkSeconds - totals.valuableTalkSeconds),
    outboundPct,
    outboundMet: totals.outbound >= targets.outbound,
    realConversationsPct: realPct,
    realConversationsMet: totals.realConversations >= targets.realConversations,
    mainScore,
    activityScore: mainScore,
    targetTalkSeconds: targets.talkSeconds,
    targetTalkLabel: targets.talkLabel,
  };
}

// ─── KPI rollups ───

/**
 * Per-recruiter KPI rollup for a UTC window (start inclusive, end exclusive).
 * Returns one entry per active recruiter (even those with zero calls) plus the
 * targets/thresholds used, so dashboards can render progress vs target.
 */
async function rollupRecruiterKpis({ startUtc, endUtc, cfg, rangeDays }) {
  const thresholds = resolveThresholds(cfg);
  const targets = buildTargets(cfg, rangeDays);

  const res = await query(
    `SELECT
       r.id, r.name, r.phone_number,
       c.id AS call_id, c.direction, c.duration_seconds
     FROM recruiters r
     LEFT JOIN ringcentral_calls c
       ON c.recruiter_id = r.id
      AND c.call_time >= $1 AND c.call_time < $2
     WHERE r.active = TRUE
     ORDER BY r.name ASC, r.id ASC`,
    [startUtc, endUtc]
  );

  const byRecruiter = new Map();
  for (const row of res.rows) {
    let entry = byRecruiter.get(row.id);
    if (!entry) {
      entry = { id: row.id, name: row.name, phoneNumber: row.phone_number, calls: [] };
      byRecruiter.set(row.id, entry);
    }
    // A recruiter with zero calls in the window still yields one row (call_id NULL).
    if (row.call_id != null) {
      entry.calls.push({ direction: row.direction, durationSeconds: row.duration_seconds });
    }
  }

  const recruiters = [...byRecruiter.values()].map(({ id, name, phoneNumber, calls }) => ({
    id,
    name,
    phoneNumber,
    ...computeRecruiterKpis(summarizeCalls(calls, thresholds), targets),
  }));

  return { targets, thresholds, recruiters };
}

/**
 * Per-recruiter KPI rollup for a single day in the configured timezone.
 * dateStr null/undefined = today (dateMode "today"); otherwise "single-day".
 */
async function getRecruiterStats(dateStr, cfg) {
  const tz = cfg.timezone || 'America/Chicago';
  const day = dateStr
    ? DateTime.fromISO(dateStr, { zone: tz })
    : DateTime.now().setZone(tz);
  if (!day.isValid) throw new Error(`Invalid date: ${dateStr}`);
  const start = day.startOf('day');
  const end = start.plus({ days: 1 });

  const rollup = await rollupRecruiterKpis({
    startUtc: start.toUTC().toISO(),
    endUtc: end.toUTC().toISO(),
    cfg,
    rangeDays: 1,
  });

  const date = start.toISODate();
  return {
    dateMode: dateStr ? 'single-day' : 'today',
    date,
    startDate: date,
    endDate: date,
    rangeDays: 1,
    timezone: tz,
    ...rollup,
  };
}

/**
 * Per-recruiter KPI rollup for an inclusive date range in the configured
 * timezone. Targets scale by the number of days in the range.
 */
async function getRecruiterStatsRange(startStr, endStr, cfg) {
  const tz = cfg.timezone || 'America/Chicago';
  const startDay = DateTime.fromISO(startStr, { zone: tz });
  const endDay = DateTime.fromISO(endStr, { zone: tz });
  if (!startDay.isValid) throw new Error(`Invalid start date: ${startStr}`);
  if (!endDay.isValid) throw new Error(`Invalid end date: ${endStr}`);
  const start = startDay.startOf('day');
  const endExclusive = endDay.startOf('day').plus({ days: 1 });
  if (endExclusive <= start) throw new Error('End date must not be before start date.');
  const rangeDays = Math.round(endExclusive.diff(start, 'days').days);

  const rollup = await rollupRecruiterKpis({
    startUtc: start.toUTC().toISO(),
    endUtc: endExclusive.toUTC().toISO(),
    cfg,
    rangeDays,
  });

  return {
    dateMode: 'range',
    date: start.toISODate(),
    startDate: start.toISODate(),
    endDate: endDay.startOf('day').toISODate(),
    rangeDays,
    timezone: tz,
    ...rollup,
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
  listRecruitersForAdmin,
  getRecruiterById,
  resolveRecruiterRcAuth,
  createRecruiter,
  updateRecruiter,
  deleteRecruiter,
  getRecruiterByNormalizedNumber,
  upsertCall,
  formatTalkLabel,
  resolveThresholds,
  buildTargets,
  summarizeCalls,
  computeRecruiterKpis,
  getRecruiterStats,
  getRecruiterStatsRange,
  DEFAULT_TARGET_TALK_SECONDS,
};
