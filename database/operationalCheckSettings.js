/**
 * Per-check auto-apply permission — the admin's side of the table.
 *
 * `operational_check_settings` is seeded with NO rows on purpose: a check with
 * no row is disabled, so nothing the consistency engine proposes can be applied
 * by software until a person turns that specific check on. This module is how a
 * person turns it on.
 *
 * Deliberately separate from `services/operations/corrections/autoApply.js`,
 * which reads the same table through its own `loadCheckSettings(db)`. That is
 * not duplicated logic, it is a different question asked of the same rows: the
 * batch wants a Map keyed by check, resolved against an INJECTED db so a test
 * can run a whole sweep against a throwaway database. The admin wants a list,
 * including the checks that have no row at all — which is most of them, and
 * which a Map of existing rows can never show.
 */
const { query } = require('./pool');

function mapSetting(row) {
  if (!row) return null;
  return {
    checkKey: row.check_key,
    autoApplyEnabled: row.auto_apply_enabled,
    maxAutoPerRun: row.max_auto_per_run,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

async function listCheckSettings() {
  const res = await query(
    `SELECT check_key, auto_apply_enabled, max_auto_per_run, updated_by, updated_at
       FROM operational_check_settings ORDER BY check_key`
  );
  return res.rows.map(mapSetting);
}

/**
 * Grant or revoke auto-apply for one check.
 *
 * `maxAutoPerRun` is clamped in JS to the range the schema's CHECK already
 * enforces, so a slider that goes wrong returns a corrected value rather than a
 * constraint violation the admin cannot read — the house rule from
 * `samsaraSettings`. Omitting it keeps whatever the row already had.
 */
async function upsertCheckSettings(checkKey, { autoApplyEnabled, maxAutoPerRun, updatedBy = null } = {}) {
  const clamped = maxAutoPerRun == null
    ? null
    : Math.min(500, Math.max(1, Math.round(Number(maxAutoPerRun) || 0) || 1));
  const res = await query(
    `INSERT INTO operational_check_settings
       (check_key, auto_apply_enabled, max_auto_per_run, updated_by, updated_at)
     VALUES ($1, $2, COALESCE($3, 50), $4, NOW())
     ON CONFLICT (check_key) DO UPDATE
       SET auto_apply_enabled = EXCLUDED.auto_apply_enabled,
           max_auto_per_run = COALESCE($3, operational_check_settings.max_auto_per_run),
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()
     RETURNING *`,
    [checkKey, autoApplyEnabled === true, clamped, updatedBy]
  );
  return mapSetting(res.rows[0]);
}

/**
 * Remove a check's row entirely, restoring "no row = disabled".
 *
 * There is a real difference between a row saying FALSE and no row at all, and
 * only one revert path is honest about it: a learning suggestion that switched
 * automation off for a check which had never been configured must put back the
 * absence, not a FALSE somebody could later read as a decision.
 */
async function deleteCheckSettings(checkKey) {
  const res = await query('DELETE FROM operational_check_settings WHERE check_key = $1', [checkKey]);
  return res.rowCount > 0;
}

module.exports = {
  mapSetting, listCheckSettings, upsertCheckSettings, deleteCheckSettings,
};
