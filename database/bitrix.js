/**
 * Bitrix24 SETTINGS — the single row the admin panel edits, and the effective
 * configuration the rest of the app reads.
 *
 * WHY THIS EXISTS. Bitrix was configured only by environment variables, so a
 * wrong assignee id or a rotated webhook meant a Render deploy by whoever holds
 * that dashboard, while every other integration (RingCentral, ELD, GMaps …) is
 * entered in Settings. This gives Bitrix the same shape as
 * database/ringcentral/settings.js: one row, DB over env, secret encrypted.
 *
 * THE RESOLUTION RULE, in one place (resolveBitrixConfig, pure): a NULL column
 * means "not set in the app — inherit the BITRIX24_* env var". So an env-only
 * deployment behaves exactly as before until someone saves, and a half-filled
 * form still works. `assigned_by_id` is TEXT so '' can mean "explicitly
 * nobody" — distinct from NULL — because the env value it must beat is a NAME
 * Bitrix ignores, and "clear it" has to win over "inherit it".
 *
 * THE URL IS THE CREDENTIAL. A Bitrix inbound webhook authenticates by its
 * path, so it is encrypted at rest and the admin view exposes its HOST only —
 * not even a masked tail, since the tail is part of the token.
 *
 * SHARED MUTABLE STATE — this module is the sole owner of the settings cache;
 * every writer calls invalidateBitrixSettingsCache().
 */
const { query } = require('./pool');
const config = require('../config/config');
const { encryptText } = require('../lib/security/facebookCrypto');
const { safeDecrypt } = require('./ringcentral/secrets');

const SETTINGS_CACHE_TTL_MS = 15_000;
/** Longer than any distribution rule needs; guards a typo like 25000000. */
const MAX_ASSIGNEE_WAIT_MS = 600_000;

let settingsCache = null;
let settingsCacheExpiresAt = 0;

function invalidateBitrixSettingsCache() {
  settingsCache = null;
  settingsCacheExpiresAt = 0;
}

async function getBitrixSettingsRow() {
  try {
    const res = await query('SELECT * FROM bitrix_settings WHERE id = 1');
    return res.rows[0] || null;
  } catch (err) {
    console.warn('[Bitrix24] bitrix_settings unavailable:', err.message);
    return null;
  }
}

/** A stored value beats env; a NULL (never saved) inherits env. */
const pick = (rowValue, envValue) => (rowValue === null || rowValue === undefined ? envValue : rowValue);

const normalizeEntity = (value) => (String(value || '').trim().toLowerCase() === 'deal' ? 'deal' : 'lead');

/** A 400 the route can pass straight through. */
function invalid(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/**
 * The effective configuration for one settings row over one env. Pure, so the
 * precedence rules are unit-tested without a database.
 */
function resolveBitrixConfig(row, env = config) {
  const storedUrl = safeDecrypt(row?.webhook_url_encrypted);
  return {
    enabled: pick(row?.enabled, env.bitrix24Enabled) === true,
    webhookUrl: storedUrl || String(env.bitrix24WebhookUrl || '').trim(),
    entity: normalizeEntity(pick(row?.entity, env.bitrix24Entity)),
    assignedById: String(pick(row?.assigned_by_id, env.bitrix24AssignedById) ?? '').trim(),
    sourceId: String(pick(row?.source_id, env.bitrix24SourceId) ?? '').trim() || 'WEB',
    sourceDescription: String(pick(row?.source_description, env.bitrix24SourceDescription) ?? '').trim(),
    dealCategoryId: String(pick(row?.deal_category_id, env.bitrix24DealCategoryId) ?? '').trim(),
    dealStageId: String(pick(row?.deal_stage_id, env.bitrix24DealStageId) ?? '').trim(),
    assigneeWaitMs: Math.max(0, Number(pick(row?.assignee_wait_ms, env.bitrix24AssigneeWaitMs)) || 0),
    // Which values are still coming from the host rather than the panel.
    fromEnv: {
      enabled: row?.enabled === null || row?.enabled === undefined,
      webhookUrl: !storedUrl,
      entity: row?.entity === null || row?.entity === undefined,
      assignedById: row?.assigned_by_id === null || row?.assigned_by_id === undefined,
      assigneeWaitMs: row?.assignee_wait_ms === null || row?.assignee_wait_ms === undefined,
    },
    updatedAt: row?.updated_at || null,
  };
}

/** Effective decrypted config for server use (DB over env). Cached briefly. */
async function getBitrixConfig() {
  const now = Date.now();
  if (settingsCache && now < settingsCacheExpiresAt) return settingsCache;
  const effective = resolveBitrixConfig(await getBitrixSettingsRow(), config);
  settingsCache = effective;
  settingsCacheExpiresAt = now + SETTINGS_CACHE_TTL_MS;
  return effective;
}

/** Host only — never the URL, never a masked tail of it. */
function hostOf(url) {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return 'unparseable';
  }
}

/** Masked view for the admin GET — the webhook URL never appears in it. */
async function getBitrixSettingsForAdmin() {
  const cfg = await getBitrixConfig();
  return {
    enabled: cfg.enabled,
    webhookSet: Boolean(cfg.webhookUrl),
    webhookHost: hostOf(cfg.webhookUrl),
    entity: cfg.entity,
    assignedById: cfg.assignedById,
    sourceId: cfg.sourceId,
    sourceDescription: cfg.sourceDescription,
    dealCategoryId: cfg.dealCategoryId,
    dealStageId: cfg.dealStageId,
    assigneeWaitMs: cfg.assigneeWaitMs,
    fromEnv: cfg.fromEnv,
    updatedAt: cfg.updatedAt,
  };
}

/**
 * Normalize the assignee an operator typed: blank → '' (explicitly nobody), a
 * positive integer → that id as text, anything else → a 400. A NAME is the
 * production mistake this exists to refuse — Bitrix silently ignores it.
 */
function normalizeAssignedById(value) {
  const text = String(value ?? '').trim();
  if (text === '') return '';
  const fromUrl = text.match(/user\/(\d+)/i);
  const candidate = fromUrl ? fromUrl[1] : text.replace(/^#/, '').trim();
  if (/^\d+$/.test(candidate) && Number(candidate) > 0) return candidate;
  throw invalid(`"${text}" is not a Bitrix user id — use the number from the profile URL (e.g. 17), or leave it blank.`);
}

async function updateBitrixSettings(payload = {}) {
  const sets = [];
  const values = [];
  let i = 1;
  const set = (column, value) => { sets.push(`${column} = $${i++}`); values.push(value); };
  const setText = (column, value) => {
    if (value === undefined) return;
    set(column, value === null ? '' : String(value).trim());
  };

  if (typeof payload.enabled === 'boolean') set('enabled', payload.enabled);

  if (payload.clearWebhookUrl === true) {
    sets.push('webhook_url_encrypted = NULL');
  } else if (typeof payload.webhookUrl === 'string' && payload.webhookUrl.trim()) {
    const url = payload.webhookUrl.trim();
    if (!/^https?:\/\/\S+\/rest\/\d+\/\S+/i.test(url)) {
      throw invalid('The webhook URL should look like https://<portal>.bitrix24.com/rest/<user>/<token>/ — copy it from Developer resources → Inbound webhook.');
    }
    set('webhook_url_encrypted', encryptText(url));
  }

  if (payload.entity !== undefined) {
    const entity = String(payload.entity || '').trim().toLowerCase();
    if (entity !== 'lead' && entity !== 'deal') throw invalid('Entity must be "lead" or "deal".');
    set('entity', entity);
  }

  if (payload.assignedById !== undefined) set('assigned_by_id', normalizeAssignedById(payload.assignedById));
  setText('source_id', payload.sourceId);
  setText('source_description', payload.sourceDescription);
  setText('deal_category_id', payload.dealCategoryId);
  setText('deal_stage_id', payload.dealStageId);

  if (payload.assigneeWaitMs !== undefined && payload.assigneeWaitMs !== null && payload.assigneeWaitMs !== '') {
    const ms = Number.parseInt(payload.assigneeWaitMs, 10);
    if (!Number.isFinite(ms) || ms < 0) throw invalid('Assignee wait must be zero or more milliseconds.');
    set('assignee_wait_ms', Math.min(MAX_ASSIGNEE_WAIT_MS, ms));
  }

  if (sets.length) {
    // The migration seeds the row; this keeps a save working even if it was
    // ever removed by hand.
    await query('INSERT INTO bitrix_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
    sets.push('updated_at = NOW()');
    await query(`UPDATE bitrix_settings SET ${sets.join(', ')} WHERE id = 1`, values);
  }
  invalidateBitrixSettingsCache();
  return getBitrixSettingsForAdmin();
}

module.exports = {
  MAX_ASSIGNEE_WAIT_MS,
  invalidateBitrixSettingsCache,
  getBitrixSettingsRow,
  resolveBitrixConfig,
  normalizeAssignedById,
  getBitrixConfig,
  getBitrixSettingsForAdmin,
  updateBitrixSettings,
};
