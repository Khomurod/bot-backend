/**
 * Duplicate unit-number reports — database helpers.
 *
 * Backs the 15-minute duplicate-truck sanity check: which active driver groups
 * share a unit number, and where a provider vehicle label's driver disagrees
 * with the group it is matched to. Reports are keyed by (unit_number,
 * report_type), reopened/refreshed on each run, and auto-resolved when the issue
 * clears — so the admin sees only currently-open problems.
 */
const { query } = require('./db');

/** Active driver groups with a unit number — the set the sanity check scans. */
async function listActiveDriverUnits() {
  const res = await query(
    `SELECT g.id AS group_id, g.group_name, g.telegram_group_id,
            dp.unit_number, dp.first_name, dp.last_name
     FROM groups g
     LEFT JOIN driver_profiles dp ON dp.group_id = g.id
     WHERE g.group_type = 'driver' AND g.active = TRUE
       AND dp.unit_number IS NOT NULL AND btrim(dp.unit_number) <> ''
     ORDER BY dp.unit_number ASC, g.id ASC`
  );
  return res.rows;
}

/**
 * Insert or refresh a report. On conflict (same unit + type) it updates the
 * detail/severity/group info, bumps last_seen_at, and reopens a resolved row.
 * Returns the row (with its id).
 */
async function upsertDuplicateUnitReport({
  unitNumber, reportType, groupIds = [], groupNames = [],
  groupDriverName = null, provider = null, providerDriverName = null,
  detail = null, severity = 'info',
}) {
  const res = await query(
    `INSERT INTO duplicate_unit_reports
       (unit_number, report_type, group_ids, group_names, group_driver_name,
        provider, provider_driver_name, detail, severity, status, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',NOW())
     ON CONFLICT (unit_number, report_type) DO UPDATE SET
       group_ids = EXCLUDED.group_ids,
       group_names = EXCLUDED.group_names,
       group_driver_name = EXCLUDED.group_driver_name,
       provider = EXCLUDED.provider,
       provider_driver_name = EXCLUDED.provider_driver_name,
       detail = EXCLUDED.detail,
       severity = EXCLUDED.severity,
       status = 'open',
       resolved_at = NULL,
       last_seen_at = NOW()
     RETURNING *`,
    [
      unitNumber, reportType, groupIds, groupNames, groupDriverName,
      provider, providerDriverName, detail, severity,
    ]
  );
  return res.rows[0];
}

/**
 * Auto-resolve OPEN reports that were NOT seen this run — but only among the
 * report types we actually evaluated, so a run that couldn't reach Samsara does
 * not falsely clear name-mismatch reports it never checked.
 */
async function resolveStaleReports(keepIds = [], evaluatedTypes = []) {
  if (!evaluatedTypes.length) return 0;
  const res = await query(
    `UPDATE duplicate_unit_reports
       SET status = 'resolved', resolved_at = NOW()
     WHERE status = 'open'
       AND report_type = ANY($2)
       AND NOT (id = ANY($1))
     RETURNING id`,
    [keepIds.length ? keepIds : [-1], evaluatedTypes]
  );
  return res.rows.length;
}

async function listDuplicateUnitReports({ status = 'open', limit = 200 } = {}) {
  const clauses = [];
  const values = [];
  let i = 1;
  if (status && status !== 'all') { clauses.push(`status = $${i++}`); values.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(limit);
  const res = await query(
    `SELECT * FROM duplicate_unit_reports ${where}
     ORDER BY (severity = 'serious') DESC, last_seen_at DESC
     LIMIT $${i}`,
    values
  );
  return res.rows;
}

async function resolveDuplicateUnitReport(id) {
  const res = await query(
    `UPDATE duplicate_unit_reports SET status = 'resolved', resolved_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id]
  );
  return res.rows[0] || null;
}

module.exports = {
  listActiveDriverUnits,
  upsertDuplicateUnitReport,
  resolveStaleReports,
  listDuplicateUnitReports,
  resolveDuplicateUnitReport,
};
