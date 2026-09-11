'use strict';

/**
 * When the recruiting team works, and whether Wenze may speak when they do not.
 *
 * One row, id = 1 — the settings shape this repository uses everywhere
 * (database/samsaraSettings.js is the reference): a 30-second cache,
 * omit-means-keep on write, and `invalidateCache()` after every write rather
 * than before, so a concurrent read cannot repopulate the cache from the old
 * row between the two.
 *
 * There is no environment fallback here, deliberately. Every other settings
 * module treats NULL as "inherit the environment", because the value it holds
 * had an env var before it had a screen. Working hours never did, and inventing
 * WENZE_RECRUITING_HOURS would create a second place to look for the answer to
 * "why did Wenze text a candidate at midnight".
 */
const { query } = require('./pool');

const CACHE_MS = 30 * 1000;
let cache = { at: 0, value: null };

const DEFAULTS = {
  timezone: 'America/Chicago',
  windows: [],
  aiAfterHoursEnabled: false,
  maxRepliesPerConversation: 4,
  quietStartLocal: '21:00',
  quietEndLocal: '08:00',
};

function mapRow(row) {
  if (!row) return { ...DEFAULTS };
  return {
    timezone: row.timezone || DEFAULTS.timezone,
    windows: Array.isArray(row.windows) ? row.windows : [],
    aiAfterHoursEnabled: row.ai_after_hours_enabled === true,
    maxRepliesPerConversation: Number(row.max_replies_per_conversation ?? DEFAULTS.maxRepliesPerConversation),
    quietStartLocal: shortTime(row.quiet_start_local) || DEFAULTS.quietStartLocal,
    quietEndLocal: shortTime(row.quiet_end_local) || DEFAULTS.quietEndLocal,
    updatedAt: row.updated_at || null,
    updatedBy: row.updated_by || null,
  };
}

/** Postgres returns TIME as 'HH:MM:SS'; the screen and the pure module want 'HH:MM'. */
function shortTime(value) {
  const match = /^(\d{2}:\d{2})/.exec(String(value || ''));
  return match ? match[1] : null;
}

function invalidateCache() {
  cache = { at: 0, value: null };
}

/**
 * The settings, cached. A missing table or an unreachable database answers with
 * the defaults — which have the feature OFF, so a database problem can never
 * turn Wenze loose on a candidate.
 */
async function getRecruitingHours() {
  if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  try {
    const res = await query('SELECT * FROM recruiting_hours_settings WHERE id = 1');
    const value = mapRow(res.rows[0]);
    cache = { at: Date.now(), value };
    return value;
  } catch (err) {
    console.warn('[RecruitingHours] could not read settings:', err.message);
    return { ...DEFAULTS };
  }
}

const FIELDS = new Map([
  ['timezone', 'timezone'],
  ['windows', 'windows'],
  ['aiAfterHoursEnabled', 'ai_after_hours_enabled'],
  ['maxRepliesPerConversation', 'max_replies_per_conversation'],
  ['quietStartLocal', 'quiet_start_local'],
  ['quietEndLocal', 'quiet_end_local'],
]);

/** Omit a key to leave it alone. `windows` is replaced whole — it is a list. */
async function updateRecruitingHours(patch = {}, { updatedBy = null } = {}) {
  const sets = [];
  const values = [];
  for (const [key, column] of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const raw = patch[key];
    values.push(key === 'windows' ? JSON.stringify(raw ?? []) : raw);
    sets.push(`${column} = $${values.length}${key === 'windows' ? '::jsonb' : ''}`);
  }
  if (!sets.length) return getRecruitingHours();

  values.push(updatedBy);
  sets.push(`updated_by = $${values.length}`);

  const res = await query(
    `UPDATE recruiting_hours_settings SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = 1 RETURNING *`,
    values
  );
  invalidateCache();
  return mapRow(res.rows[0]);
}

module.exports = {
  DEFAULTS,
  getRecruitingHours,
  updateRecruitingHours,
  invalidateCache,
  mapRow,
};
