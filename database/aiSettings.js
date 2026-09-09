/**
 * The AI master switches, and what AI is allowed to be used FOR.
 *
 * Two tables, one module, because they answer the same operator question from
 * two directions: `ai_settings` is "may Wenze use AI at all, and how", and
 * `ai_capabilities` is "may AI decide THIS". Splitting them across files would
 * separate a switch from its scope.
 *
 * THE MASTER SWITCH IS A SUPPORTED MODE, NOT AN OUTAGE. `enabled = FALSE` sends
 * every capability to its deterministic path, and twelve of the existing
 * consumers already have one. The test suite runs green with AI off; that is
 * the enforceable form of "deterministic logic must not depend on AI", and it
 * is why nothing here may ever become required.
 *
 * A 30-second cache with explicit invalidation, matching every other settings
 * module in this repository — the router reads this on every call, and hitting
 * Postgres for a config row on every AI request would be silly.
 */
const { query } = require('./pool');

const CACHE_TTL_MS = 30_000;
let cache = null;
let cacheExpiresAt = 0;

function invalidateCache() {
  cache = null;
  cacheExpiresAt = 0;
}

const DEFAULTS = {
  enabled: true,
  freeOnlyMode: true,
  routingMode: 'priority',
  requestTimeoutMs: 60_000,
  maxRetryWaitMs: 35_000,
  callLogRetentionDays: 30,
};

function mapSettings(row) {
  if (!row) return { ...DEFAULTS, updatedBy: null, updatedAt: null };
  return {
    enabled: row.enabled,
    freeOnlyMode: row.free_only_mode,
    routingMode: row.routing_mode,
    requestTimeoutMs: row.request_timeout_ms,
    maxRetryWaitMs: row.max_retry_wait_ms,
    callLogRetentionDays: row.call_log_retention_days,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

/**
 * Read the settings.
 *
 * A missing table or an unreachable database yields the DEFAULTS rather than
 * throwing: this is read on the hot path of every AI call, and an AI feature
 * must never be the thing that takes a request down. The defaults are also the
 * conservative choice — free-only on, strict priority.
 */
async function getAiSettings() {
  const now = Date.now();
  if (cache && now < cacheExpiresAt) return cache;
  try {
    const res = await query('SELECT * FROM ai_settings WHERE id = 1');
    cache = mapSettings(res.rows[0]);
  } catch (err) {
    console.warn('[AI SETTINGS] Falling back to defaults:', err.message);
    cache = { ...DEFAULTS, updatedBy: null, updatedAt: null };
  }
  cacheExpiresAt = now + CACHE_TTL_MS;
  return cache;
}

/** Clamped in JS to the ranges the schema CHECKs already enforce. */
function clamp(value, min, max) {
  if (value == null) return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

async function updateAiSettings(patch = {}, updatedBy = null) {
  const sets = [];
  const values = [];
  let i = 1;
  const set = (column, value) => {
    if (value === undefined || value === null) return;
    sets.push(`${column} = $${i}`);
    values.push(value);
    i += 1;
  };
  set('enabled', typeof patch.enabled === 'boolean' ? patch.enabled : undefined);
  set('free_only_mode', typeof patch.freeOnlyMode === 'boolean' ? patch.freeOnlyMode : undefined);
  if (patch.routingMode === 'priority' || patch.routingMode === 'round_robin') {
    set('routing_mode', patch.routingMode);
  }
  set('request_timeout_ms', clamp(patch.requestTimeoutMs, 5_000, 300_000));
  set('max_retry_wait_ms', clamp(patch.maxRetryWaitMs, 0, 120_000));
  set('call_log_retention_days', clamp(patch.callLogRetentionDays, 1, 365));
  set('updated_by', updatedBy);
  sets.push('updated_at = NOW()');

  const res = await query(
    `UPDATE ai_settings SET ${sets.join(', ')} WHERE id = 1 RETURNING *`,
    values
  );
  invalidateCache();
  return mapSettings(res.rows[0]);
}

// ─── capabilities ────────────────────────────────────────────────────────────

function mapCapability(row) {
  if (!row) return null;
  return {
    capabilityKey: row.capability_key,
    label: row.label,
    aiEnabled: row.ai_enabled,
    providerOverride: row.provider_override,
    sendsRawText: row.sends_raw_text,
    hasDeterministicFallback: row.has_deterministic_fallback,
    mayPropose: row.may_propose,
    mayAutoApply: row.may_auto_apply,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

async function listCapabilities() {
  const res = await query('SELECT * FROM ai_capabilities ORDER BY capability_key');
  return res.rows.map(mapCapability);
}

/**
 * Register a capability, or update the parts an operator controls.
 *
 * `sendsRawText` and `hasDeterministicFallback` are facts about the CODE, so a
 * registration always refreshes them; an operator cannot toggle whether a
 * consumer happens to have a fallback, and pretending otherwise in the UI would
 * be a lie with consequences.
 */
async function registerCapability(capabilityKey, {
  label, sendsRawText = false, hasDeterministicFallback = true,
} = {}) {
  const res = await query(
    `INSERT INTO ai_capabilities (capability_key, label, sends_raw_text, has_deterministic_fallback)
     VALUES ($1, COALESCE($2, $1), $3, $4)
     ON CONFLICT (capability_key) DO UPDATE
       SET label = EXCLUDED.label,
           sends_raw_text = EXCLUDED.sends_raw_text,
           has_deterministic_fallback = EXCLUDED.has_deterministic_fallback
     RETURNING *`,
    [capabilityKey, label ?? null, sendsRawText === true, hasDeterministicFallback !== false]
  );
  return mapCapability(res.rows[0]);
}

/**
 * The operator's controls only.
 *
 * `may_auto_apply` is deliberately absent: the schema refuses TRUE outright, so
 * there is no value to send and no route that could send one. AI may rank and
 * explain an operational finding; it may never author or apply a correction.
 */
async function updateCapability(capabilityKey, {
  aiEnabled, providerOverride, clearProviderOverride = false, mayPropose, updatedBy = null,
} = {}) {
  const sets = [];
  const values = [capabilityKey];
  let i = 2;
  const set = (column, value) => {
    if (value === undefined || value === null) return;
    sets.push(`${column} = $${i}`);
    values.push(value);
    i += 1;
  };
  set('ai_enabled', typeof aiEnabled === 'boolean' ? aiEnabled : undefined);
  set('may_propose', typeof mayPropose === 'boolean' ? mayPropose : undefined);
  if (clearProviderOverride) sets.push('provider_override = NULL');
  else set('provider_override', providerOverride);
  set('updated_by', updatedBy);
  sets.push('updated_at = NOW()');

  const res = await query(
    `UPDATE ai_capabilities SET ${sets.join(', ')} WHERE capability_key = $1 RETURNING *`,
    values
  );
  return mapCapability(res.rows[0]);
}

module.exports = {
  DEFAULTS,
  CACHE_TTL_MS,
  invalidateCache,
  mapSettings,
  getAiSettings,
  updateAiSettings,
  mapCapability,
  listCapabilities,
  registerCapability,
  updateCapability,
};
