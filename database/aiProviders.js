/**
 * The provider roster — who Wenze may ask, in what order, and who is currently
 * out of rotation.
 *
 * Follows the `samsaraSettings` / `gmapsSettings` shape exactly, because it is
 * the shape the rest of this application's secrets already use:
 *
 *   DB OVER ENV, PER VALUE. A NULL `api_key_encrypted` means "inherit the
 *   environment", so today's `GROQ_API_KEY` / `GEMINI_API_KEY` deployment keeps
 *   working with nothing migrated and no Render variable touched.
 *
 *   OMIT MEANS KEEP, `clearApiKey` MEANS NULL. A save that does not mention the
 *   key leaves it alone; only an explicit clear removes it, and removing it
 *   hands the provider back to the environment rather than breaking it.
 *
 *   MASKED READS ONLY. `••••abcd` and nothing else ever leaves this module for
 *   the admin. `getProvidersForRouter` is the one function that decrypts, and
 *   it exists for the router alone.
 *
 * `enabled` and the cooldown columns are deliberately written by different
 * functions. `enabled` is a person's decision and only `upsertProvider` touches
 * it; `cooled_until` is the system's temporary opinion and only `recordSuccess`
 * / `recordFailure` / `clearCooldown` touch it. Nothing in this file can
 * disable a provider — software may stop asking one for a while, and that is a
 * different act from turning it off.
 */
const { query } = require('./pool');
const { encryptText } = require('../lib/security/facebookCrypto');
const { maskKey, createSafeDecrypt } = require('../lib/security/secretMasking');
const { INDEFINITE } = require('../lib/ai/cooldown');

const safeDecrypt = createSafeDecrypt('[AI SETTINGS]', 'a stored provider key');

/** Env fallbacks, so an unconfigured row still works exactly as today. */
const ENV_KEYS = {
  groq: 'GROQ_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

function envKeyFor(providerKey) {
  const name = ENV_KEYS[providerKey];
  return name ? (process.env[name] || '') : '';
}

/** The admin's view: never a usable key. */
function mapProviderForAdmin(row) {
  if (!row) return null;
  const stored = safeDecrypt(row.api_key_encrypted);
  const fromEnv = !stored && Boolean(envKeyFor(row.provider_key));
  return {
    providerKey: row.provider_key,
    label: row.label,
    adapter: row.adapter,
    enabled: row.enabled,
    priority: row.priority,
    isFree: row.is_free,
    baseUrl: row.base_url,
    modelChain: row.model_chain || [],
    apiKeySet: Boolean(stored) || fromEnv,
    apiKeyMasked: maskKey(stored) || (fromEnv ? '••••(env)' : null),
    apiKeyFromEnv: fromEnv,
    cooledUntil: row.cooled_indefinitely ? INDEFINITE : row.cooled_until,
    cooldownReason: row.cooldown_reason,
    consecutiveFailures: row.consecutive_failures,
    lastOkAt: row.last_ok_at,
    lastErrorAt: row.last_error_at,
    lastError: row.last_error,
    notes: row.notes,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

async function listProvidersForAdmin() {
  const res = await query(
    'SELECT * FROM ai_providers ORDER BY priority ASC, provider_key ASC'
  );
  return res.rows.map(mapProviderForAdmin);
}

/**
 * The router's view — the ONLY place a key is decrypted.
 *
 * Kept separate from the admin mapper so that "returns a usable secret" is one
 * named function with one caller, rather than a flag on a shared one that some
 * future route could pass by accident.
 */
async function getProvidersForRouter() {
  const res = await query(
    'SELECT * FROM ai_providers WHERE enabled = TRUE ORDER BY priority ASC, provider_key ASC'
  );
  return res.rows.map((row) => ({
    providerKey: row.provider_key,
    adapter: row.adapter,
    enabled: row.enabled,
    priority: row.priority,
    isFree: row.is_free,
    baseUrl: row.base_url,
    modelChain: Array.isArray(row.model_chain) ? row.model_chain : [],
    apiKey: safeDecrypt(row.api_key_encrypted) || envKeyFor(row.provider_key),
    cooledUntil: row.cooled_indefinitely ? INDEFINITE : row.cooled_until,
    cooldownReason: row.cooldown_reason,
    consecutiveFailures: row.consecutive_failures,
  }));
}

/**
 * Create or update one provider.
 *
 * Saving a key CLEARS ANY COOLDOWN. That is the one automatic un-cooling in the
 * system, and it is correct: a credential cooldown is indefinite precisely
 * because only a person can fix it, so the moment a person does, the reason to
 * keep waiting is gone. Making an operator save a key and then separately press
 * "clear cooldown" would be a puzzle, not a safeguard.
 */
async function upsertProvider(providerKey, {
  label, adapter, enabled, priority, isFree, baseUrl, modelChain,
  apiKey, clearApiKey = false, notes, updatedBy = null,
} = {}) {
  const sets = ['label = COALESCE($2, ai_providers.label)'];
  const values = [providerKey, label ?? null];
  let i = 3;
  const set = (column, value) => {
    if (value === undefined || value === null) return;
    sets.push(`${column} = $${i}`);
    values.push(value);
    i += 1;
  };
  set('adapter', adapter);
  set('enabled', typeof enabled === 'boolean' ? enabled : undefined);
  set('priority', priority == null ? undefined : Math.min(999, Math.max(1, Number(priority) || 100)));
  set('is_free', typeof isFree === 'boolean' ? isFree : undefined);
  set('base_url', baseUrl);
  set('notes', notes);
  if (modelChain !== undefined && modelChain !== null) {
    sets.push(`model_chain = $${i}::jsonb`);
    values.push(JSON.stringify(Array.isArray(modelChain) ? modelChain : []));
    i += 1;
  }

  let clearsCooldown = false;
  if (clearApiKey) {
    sets.push('api_key_encrypted = NULL', 'api_key_last4 = NULL');
    clearsCooldown = true;
  } else if (typeof apiKey === 'string' && apiKey.trim()) {
    const trimmed = apiKey.trim();
    sets.push(`api_key_encrypted = $${i}`);
    values.push(encryptText(trimmed));
    i += 1;
    sets.push(`api_key_last4 = $${i}`);
    values.push(trimmed.slice(-4));
    i += 1;
    clearsCooldown = true;
  }
  if (clearsCooldown) {
    sets.push(
      'cooled_until = NULL', 'cooled_indefinitely = FALSE',
      'cooldown_reason = NULL', 'consecutive_failures = 0'
    );
  }
  sets.push(`updated_by = $${i}`);
  values.push(updatedBy);
  i += 1;
  sets.push('updated_at = NOW()');

  // Insert a bare row at the schema's own defaults, then apply the patch through
  // the parameterised UPDATE above. Every caller-supplied value — `adapter`
  // included — travels as a bind parameter and never as SQL text: this function
  // is reached from a request body, and the column names in `sets` are the only
  // thing interpolated, all of them literals in this file.
  await query(
    `INSERT INTO ai_providers (provider_key, label)
     VALUES ($1, COALESCE($2, $1))
     ON CONFLICT (provider_key) DO NOTHING`,
    [providerKey, label ?? null]
  );
  const res = await query(
    `UPDATE ai_providers SET ${sets.join(', ')} WHERE provider_key = $1 RETURNING *`,
    values
  );
  return mapProviderForAdmin(res.rows[0]);
}

/** A provider answered. Health is reset, not merely nudged. */
async function recordSuccess(providerKey) {
  await query(
    `UPDATE ai_providers
        SET last_ok_at = NOW(), consecutive_failures = 0,
            cooled_until = NULL, cooled_indefinitely = FALSE, cooldown_reason = NULL
      WHERE provider_key = $1`,
    [providerKey]
  );
}

/**
 * A provider failed. `cooldown` comes from lib/ai/cooldown — this function
 * decides nothing, it only records.
 */
async function recordFailure(providerKey, { message, cooldown }) {
  const indefinite = cooldown?.until === INDEFINITE;
  const until = indefinite || cooldown?.until == null ? null : new Date(cooldown.until);
  await query(
    `UPDATE ai_providers
        SET last_error_at = NOW(),
            last_error = $2,
            consecutive_failures = consecutive_failures + 1,
            cooled_until = $3,
            cooled_indefinitely = $4,
            cooldown_reason = $5
      WHERE provider_key = $1`,
    [
      providerKey,
      String(message || '').slice(0, 500),
      until,
      indefinite,
      cooldown?.reason ?? null,
    ]
  );
}

/** An operator putting a provider back in rotation by hand. */
async function clearCooldown(providerKey, updatedBy = null) {
  const res = await query(
    `UPDATE ai_providers
        SET cooled_until = NULL, cooled_indefinitely = FALSE, cooldown_reason = NULL,
            consecutive_failures = 0, updated_by = $2, updated_at = NOW()
      WHERE provider_key = $1 RETURNING *`,
    [providerKey, updatedBy]
  );
  return mapProviderForAdmin(res.rows[0]);
}

async function deleteProvider(providerKey) {
  const res = await query('DELETE FROM ai_providers WHERE provider_key = $1', [providerKey]);
  return res.rowCount > 0;
}

module.exports = {
  ENV_KEYS,
  envKeyFor,
  mapProviderForAdmin,
  listProvidersForAdmin,
  getProvidersForRouter,
  upsertProvider,
  recordSuccess,
  recordFailure,
  clearCooldown,
  deleteProvider,
};
