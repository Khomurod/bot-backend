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

/** Widening order, least authority first. An unknown value resolves to the middle. */
const MODES = ['observe', 'suggest', 'autopilot'];

/**
 * The house seam for joining a caller's transaction.
 *
 * `insertAdminAudit(entry, client)` has worked this way since the correction
 * engine was written: pass a client and the write joins that transaction,
 * pass nothing and it runs on the pool. Learning acceptance needs it because
 * changing a setting and recording that it changed must commit together or not
 * at all — see `services/operations/learningDecision.js`.
 */
function runner(client) {
  return client ? client.query.bind(client) : query;
}

function mapSetting(row) {
  if (!row) return null;
  return {
    checkKey: row.check_key,
    // `mode` is the setting; `autoApplyEnabled` is the same fact in the shape
    // `services/operations/corrections/autoApply.js` has always read. A CHECK
    // in migration 0044 makes them unable to disagree, so both may be trusted.
    mode: row.mode || (row.auto_apply_enabled ? 'autopilot' : 'suggest'),
    shadow: row.shadow === true,
    autoApplyEnabled: row.auto_apply_enabled,
    maxAutoPerRun: row.max_auto_per_run,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

async function listCheckSettings(client = null) {
  const res = await runner(client)(
    `SELECT check_key, mode, shadow, auto_apply_enabled, max_auto_per_run,
            updated_by, updated_at
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
async function upsertCheckSettings(
  checkKey,
  { mode, autoApplyEnabled, shadow, maxAutoPerRun, updatedBy = null } = {},
  client = null
) {
  const clamped = maxAutoPerRun == null
    ? null
    : Math.min(500, Math.max(1, Math.round(Number(maxAutoPerRun) || 0) || 1));

  // A MODE WINS OVER THE BOOLEAN, and an unreadable mode falls to `suggest`
  // rather than to autopilot. Callers that still pass only `autoApplyEnabled`
  // — the older routes and the learning action that switches automation off —
  // keep working unchanged and get the mode that means the same thing.
  //
  // AND MENTIONING NEITHER KEEPS WHAT IS THERE. Resolving an absent mode to a
  // default would mean that turning shadow on and off again silently disarmed
  // a check somebody had put in Autopilot — a settings write that changes a
  // setting nobody named. `null` here means "leave it", resolved in the SQL.
  let resolved = null;
  if (mode !== undefined) resolved = MODES.includes(mode) ? mode : 'suggest';
  else if (autoApplyEnabled !== undefined) resolved = autoApplyEnabled === true ? 'autopilot' : 'suggest';

  const res = await runner(client)(
    `INSERT INTO operational_check_settings
       (check_key, mode, shadow, auto_apply_enabled, max_auto_per_run, updated_by, updated_at)
     VALUES ($1, COALESCE($2, 'suggest'), COALESCE($3, FALSE),
             COALESCE($2, 'suggest') = 'autopilot', COALESCE($4, 50), $5, NOW())
     ON CONFLICT (check_key) DO UPDATE
       SET mode = COALESCE($2, operational_check_settings.mode),
           shadow = COALESCE($3, operational_check_settings.shadow),
           -- Derived from the mode in the SAME statement, so the two can never
           -- be written apart. The schema's CHECK refuses it if they ever are.
           auto_apply_enabled =
             COALESCE($2, operational_check_settings.mode) = 'autopilot',
           max_auto_per_run = COALESCE($4, operational_check_settings.max_auto_per_run),
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()
     RETURNING *`,
    [checkKey, resolved, shadow === undefined ? null : shadow === true, clamped, updatedBy]
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
async function deleteCheckSettings(checkKey, client = null) {
  const res = await runner(client)('DELETE FROM operational_check_settings WHERE check_key = $1', [checkKey]);
  return res.rowCount > 0;
}

module.exports = {
  MODES, mapSetting, listCheckSettings, upsertCheckSettings, deleteCheckSettings,
};
