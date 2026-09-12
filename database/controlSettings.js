/**
 * The control channel's switch and its limits.
 *
 * Single row id=1, the settings shape this repository uses everywhere
 * (`database/samsaraSettings.js` is the reference): a 30-second cache,
 * `invalidateCache()` on every write, omit-means-keep on update, and JS
 * clamping that mirrors the DB CHECKs so a bad value is refused before it
 * reaches Postgres rather than as a constraint error.
 *
 * WHY THE LIMITS EXIST, since they read like arbitrary numbers:
 *
 *   `max_questions_per_pass`  a sweep that found forty things must not ask
 *                             forty questions. Forty unanswered questions is
 *                             the old silence with extra steps.
 *   `repeat_after_hours`      an unanswered question may be asked again, but
 *                             not every fifteen minutes. Nagging is how a
 *                             channel gets muted.
 *   `clarify_limit`           how many times Wenze may come back with "why?"
 *                             before it stops asking and takes the default.
 */
const { query } = require('./pool');

const CACHE_MS = 30_000;
const DEFAULTS = Object.freeze({
  enabled: true,
  maxQuestionsPerPass: 5,
  repeatAfterHours: 72,
  clarifyLimit: 1,
});

let cache = null;
let cachedAt = 0;

function invalidateCache() {
  cache = null;
  cachedAt = 0;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function mapRow(row) {
  if (!row) return { ...DEFAULTS };
  return {
    enabled: row.enabled !== false,
    maxQuestionsPerPass: Number(row.max_questions_per_pass) || DEFAULTS.maxQuestionsPerPass,
    repeatAfterHours: Number(row.repeat_after_hours) || DEFAULTS.repeatAfterHours,
    clarifyLimit: Number(row.clarify_limit ?? DEFAULTS.clarifyLimit),
    updatedAt: row.updated_at || null,
    updatedBy: row.updated_by || null,
  };
}

/**
 * Read the settings.
 *
 * A MISSING TABLE READS AS THE DEFAULTS, NOT AS AN ERROR. This is called from
 * the sweep and from the bot's message path; on a deploy where the migration
 * has not yet run, throwing here would take both down. The defaults are the
 * migration's defaults, so behaviour is the same either way.
 */
async function getControlSettings({ force = false } = {}) {
  if (!force && cache && Date.now() - cachedAt < CACHE_MS) return cache;
  try {
    const res = await query('SELECT * FROM control_settings WHERE id = 1');
    cache = mapRow(res.rows[0]);
  } catch (_) {
    cache = { ...DEFAULTS };
  }
  cachedAt = Date.now();
  return cache;
}

/**
 * Update the settings. Omitted keys keep their stored value.
 */
async function updateControlSettings(patch = {}, { updatedBy = null } = {}) {
  const sets = [];
  const values = [];
  const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

  if (patch.enabled !== undefined) push('enabled', patch.enabled === true);
  if (patch.maxQuestionsPerPass !== undefined) {
    push('max_questions_per_pass', clampInt(patch.maxQuestionsPerPass, 1, 20, DEFAULTS.maxQuestionsPerPass));
  }
  if (patch.repeatAfterHours !== undefined) {
    push('repeat_after_hours', clampInt(patch.repeatAfterHours, 1, 720, DEFAULTS.repeatAfterHours));
  }
  if (patch.clarifyLimit !== undefined) {
    push('clarify_limit', clampInt(patch.clarifyLimit, 0, 3, DEFAULTS.clarifyLimit));
  }

  if (sets.length === 0) return getControlSettings({ force: true });

  push('updated_by', updatedBy == null ? null : String(updatedBy));
  sets.push('updated_at = NOW()');

  await query(
    `INSERT INTO control_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`
  );
  const res = await query(
    `UPDATE control_settings SET ${sets.join(', ')} WHERE id = 1 RETURNING *`,
    values
  );
  invalidateCache();
  cache = mapRow(res.rows[0]);
  cachedAt = Date.now();
  return cache;
}

module.exports = {
  DEFAULTS,
  getControlSettings,
  updateControlSettings,
  invalidateCache,
};
