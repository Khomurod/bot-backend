/**
 * Where Wenze's operational notices go — the single row, id = 1.
 *
 * Follows `database/samsaraSettings.js` exactly: a 30-second cache so a hot
 * path does not hit the database on every notice, `invalidateCache()` on every
 * write, and NULL meaning "not configured" rather than a value invented here.
 *
 * One deliberate difference from the other settings tables: there is no
 * environment fallback. A destination that could come from an env var is a
 * destination nobody can see in the admin, and the whole point of this table is
 * that an administrator can answer "where do Wenze's alerts go?" by looking.
 */
const { query } = require('./pool');
const { CATEGORY_KEYS } = require('../lib/notifications/categories');

const CACHE_MS = 30_000;
let cache = null;
let cachedAt = 0;

function invalidateCache() {
  cache = null;
  cachedAt = 0;
}

function mapRow(row) {
  if (!row) return null;
  return {
    enabled: row.enabled !== false,
    defaultChatId: row.default_chat_id || null,
    categoryChatIds: row.category_chat_ids || {},
    repeatAfterHours: row.repeat_after_hours,
    updatedBy: row.updated_by || null,
    updatedAt: row.updated_at || null,
  };
}

/** The settings, cached for 30 seconds. Never throws on a missing row. */
async function getNotificationSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < CACHE_MS) return cache;
  const res = await query('SELECT * FROM operational_notification_settings WHERE id = 1');
  cache = mapRow(res.rows[0]) || {
    enabled: true, defaultChatId: null, categoryChatIds: {}, repeatAfterHours: 168,
    updatedBy: null, updatedAt: null,
  };
  cachedAt = Date.now();
  return cache;
}

/**
 * Save. Omitted fields keep their stored value — the repo's omit-means-keep
 * rule, so a form that renders one section cannot blank another.
 *
 * A category override is set by passing `{ fuel: '-100…' }` and CLEARED by
 * passing an empty string or null for that key. Keys the catalogue does not
 * know are refused rather than stored: a typo'd category would otherwise sit in
 * the JSON forever, routing nothing and explaining nothing.
 */
async function updateNotificationSettings(patch = {}) {
  const sets = [];
  const values = [];
  let i = 1;
  const set = (column, value) => {
    sets.push(`${column} = $${i}`);
    values.push(value);
    i += 1;
  };

  if (patch.enabled !== undefined) set('enabled', patch.enabled === true);
  if (patch.defaultChatId !== undefined) {
    const v = String(patch.defaultChatId ?? '').trim();
    set('default_chat_id', v === '' ? null : v);
  }
  if (patch.repeatAfterHours !== undefined) {
    const n = Number(patch.repeatAfterHours);
    // Clamped in JS to the CHECK's own range, so a bad value is a corrected
    // value rather than a 500 from a constraint violation.
    set('repeat_after_hours', Math.max(1, Math.min(8760, Number.isFinite(n) ? Math.round(n) : 168)));
  }

  if (patch.categoryChatIds !== undefined) {
    const current = (await getNotificationSettings({ fresh: true })).categoryChatIds || {};
    const next = { ...current };
    for (const [key, raw] of Object.entries(patch.categoryChatIds || {})) {
      if (!CATEGORY_KEYS.includes(key)) {
        throw new Error(`Unknown notification category "${key}".`);
      }
      const v = String(raw ?? '').trim();
      if (v === '') delete next[key];
      else next[key] = v;
    }
    set('category_chat_ids', JSON.stringify(next));
  }

  set('updated_by', patch.updatedBy ?? null);
  sets.push('updated_at = NOW()');

  const res = await query(
    `UPDATE operational_notification_settings SET ${sets.join(', ')} WHERE id = 1 RETURNING *`,
    values
  );
  invalidateCache();
  return mapRow(res.rows[0]);
}

module.exports = {
  getNotificationSettings,
  updateNotificationSettings,
  invalidateCache,
};
