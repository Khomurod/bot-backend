/**
 * What the Groups page needs BESIDE each chat — the open questions about it.
 *
 * Kept out of `services/driverGroupDirectoryService.js` because that module is
 * a pure projection over one query and this is a query against another
 * feature. Folding it in would make a screen that is mostly about chats depend
 * on the findings engine to load at all.
 *
 * THE READ FAILS SOFT, and that is the point: a Groups page that will not open
 * because the findings table is unreadable is a worse outcome than a Groups
 * page with no Needs Review badges.
 */
const { query } = require('./pool');

/** Which open findings are about a group, keyed by group id. */
const IDENTITY_PREFIXES = ['identity.', 'home_time.'];

/**
 * The checks whose open findings mean "somebody still has to decide about this
 * chat". Deliberately a PREFIX list rather than every key: a new identity
 * check should put its group on the Needs Review tab the day it ships,
 * without a second list to remember.
 */
async function openFindingKeysByGroup() {
  try {
    const res = await query(
      `SELECT subject_id, check_key
         FROM operational_findings
        WHERE status = 'open'
          AND subject_type = 'group'
          AND (snoozed_until IS NULL OR snoozed_until <= NOW())
          AND (${IDENTITY_PREFIXES.map((_, i) => `check_key LIKE $${i + 1}`).join(' OR ')})`,
      IDENTITY_PREFIXES.map((p) => `${p}%`)
    );
    const out = new Map();
    for (const row of res.rows) {
      const id = Number(row.subject_id);
      if (!Number.isFinite(id)) continue;
      if (!out.has(id)) out.set(id, []);
      out.get(id).push(row.check_key);
    }
    return out;
  } catch (_) {
    return new Map();
  }
}

/** Decorate directory rows in place-free fashion — a new array, same order. */
async function withOpenFindings(rows) {
  const findings = await openFindingKeysByGroup();
  return (rows || []).map((row) => ({
    ...row,
    open_finding_keys: findings.get(Number(row.group_id)) || [],
  }));
}

module.exports = { withOpenFindings, openFindingKeysByGroup };
