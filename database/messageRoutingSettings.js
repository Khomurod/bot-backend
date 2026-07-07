/**
 * Message routing settings — single-row store (id = 1).
 *
 * Backs the admin panel's Settings → Telegram Groups tab. Holds the Telegram
 * group ID that each bonus / review message category is delivered to. These IDs
 * used to be hardcoded constants / default env values (BONUS_GROUP_CHAT_ID,
 * EMPLOYEE_GROUP_ID); they are now edited in the panel.
 *
 * Unlike the ELD / RingCentral credential stores, Telegram group IDs are NOT
 * secrets — they are stored and returned in plaintext so an admin can read and
 * hand-edit them. Resolution order for the effective value of each category:
 *   1. the DB value (admin-entered)              ← source of truth
 *   2. the matching optional environment variable ← backwards-compat migration
 *   3. null                                        ← "not configured"
 *
 * There is deliberately NO hardcoded group-id default. When a category resolves
 * to null the caller must NOT send the message and must log a clear
 * configuration error (see MISSING_GROUP_MESSAGES) — never a silent old default.
 */
const { query } = require('./db');
const config = require('../config/config');

// Resolved config is read on hot paths (every bonus card / review post). Cache
// briefly so we don't hit the DB on every send.
const CACHE_TTL_MS = 30_000;
let cache = null;
let cacheExpiresAt = 0;

// The three message categories. Keys are used across the API + tests.
const CATEGORIES = ['mileageBonus', 'roadBonus', 'dispatchReview'];

// Clear, category-specific errors surfaced/logged when a group ID is missing.
const MISSING_GROUP_MESSAGES = {
  mileageBonus: 'Mileage bonus group ID is not configured.',
  roadBonus: 'Extra Week bonus group ID is not configured.',
  dispatchReview: 'Dispatch rate review group ID is not configured.',
};

// DB column ↔ category ↔ env fallback (via config, which reads process.env).
const CATEGORY_META = {
  mileageBonus: { column: 'mileage_bonus_group_id', envKey: 'mileageBonusGroupId' },
  roadBonus: { column: 'road_bonus_group_id', envKey: 'roadBonusGroupId' },
  dispatchReview: { column: 'dispatch_review_group_id', envKey: 'dispatchReviewGroupId' },
};

function invalidateCache() {
  cache = null;
  cacheExpiresAt = 0;
}

/** Normalize a stored/entered group ID to a trimmed string, or '' when empty. */
function normalizeGroupId(value) {
  return value == null ? '' : String(value).trim();
}

async function getSettingsRow() {
  try {
    const res = await query('SELECT * FROM message_group_settings WHERE id = 1');
    return res.rows[0] || null;
  } catch (err) {
    // Table may not exist yet on a brand-new DB before initializeDatabase ran.
    console.warn('[MESSAGE-GROUPS] message_group_settings unavailable:', err.message);
    return null;
  }
}

/**
 * Effective, resolved routing for server-side use. For each category: DB value,
 * else env fallback, else null. Also reports the source so the admin view can
 * label an env-provided value. Cached for CACHE_TTL_MS.
 */
async function getMessageGroupConfig() {
  const now = Date.now();
  if (cache && now < cacheExpiresAt) return cache;

  const row = await getSettingsRow();
  const groups = {};
  const sources = {};
  for (const category of CATEGORIES) {
    const { column, envKey } = CATEGORY_META[category];
    const dbValue = normalizeGroupId(row?.[column]);
    const envValue = normalizeGroupId(config[envKey]);
    if (dbValue) {
      groups[category] = dbValue;
      sources[category] = 'db';
    } else if (envValue) {
      groups[category] = envValue;
      sources[category] = 'env';
    } else {
      groups[category] = null;
      sources[category] = 'none';
    }
  }

  const effective = { groups, sources, updatedAt: row?.updated_at || null };
  cache = effective;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return effective;
}

/**
 * The resolved Telegram group ID for one category, or null when not configured.
 * @param {'mileageBonus'|'roadBonus'|'dispatchReview'} category
 */
async function getGroupId(category) {
  if (!CATEGORY_META[category]) {
    throw new Error(`Unknown message group category: ${category}`);
  }
  const { groups } = await getMessageGroupConfig();
  return groups[category] || null;
}

/** The clear configuration error message for a missing category. */
function missingGroupMessage(category) {
  return MISSING_GROUP_MESSAGES[category] || `${category} group ID is not configured.`;
}

/**
 * Admin view — Telegram group IDs are not secrets, so the raw values are
 * returned for hand-editing, alongside a fromEnv flag per category.
 */
async function getMessageGroupSettingsForAdmin() {
  const { groups, sources, updatedAt } = await getMessageGroupConfig();
  const out = { updatedAt };
  for (const category of CATEGORIES) {
    out[category] = {
      groupId: groups[category] || '',
      fromEnv: sources[category] === 'env',
      configured: Boolean(groups[category]),
    };
  }
  return out;
}

/**
 * Update the routing settings. For each category:
 *   - a string value (including '' to clear) is written when the key is present
 *   - omitting the key leaves the stored value unchanged
 * Payload keys are the category names (mileageBonus / roadBonus / dispatchReview).
 */
async function updateMessageGroupSettings(payload = {}) {
  const sets = [];
  const values = [];
  let i = 1;

  for (const category of CATEGORIES) {
    if (!Object.prototype.hasOwnProperty.call(payload, category)) continue;
    const { column } = CATEGORY_META[category];
    const value = normalizeGroupId(payload[category]);
    sets.push(`${column} = $${i++}`);
    values.push(value || null);
  }

  if (!sets.length) {
    invalidateCache();
    return getMessageGroupSettingsForAdmin();
  }

  sets.push('updated_at = NOW()');
  await query(`UPDATE message_group_settings SET ${sets.join(', ')} WHERE id = 1`, values);
  invalidateCache();
  return getMessageGroupSettingsForAdmin();
}

module.exports = {
  CATEGORIES,
  MISSING_GROUP_MESSAGES,
  getMessageGroupConfig,
  getGroupId,
  missingGroupMessage,
  getMessageGroupSettingsForAdmin,
  updateMessageGroupSettings,
  invalidateCache,
};
