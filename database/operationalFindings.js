/**
 * Findings: a disagreement the system noticed, in a form a human can act on.
 *
 * The lifecycle rules here are the whole design, and each one exists to stop a
 * specific way an alerting surface dies:
 *
 *   DEDUPLICATED BY (check_key, subject). A condition that is still true on the
 *   next sweep updates its row. Forty-six drivers past their road allowance must
 *   be 46 rows forever, not 46 more every fifteen minutes.
 *
 *   RE-OPENING IS ONLY FROM `resolved`. A finding a human DISMISSED — with a
 *   reason, which the schema requires — stays dismissed even while the condition
 *   holds; its `last_seen_at` still moves so the record stays honest. Re-opening
 *   it every sweep would overrule the one person who actually looked at it, and
 *   is the fastest way to teach an operator to ignore the page.
 *
 *   AUTO-RESOLVE IS SCOPED TO THE CHECKS THAT ACTUALLY RAN. Resolving everything
 *   a sweep did not re-report would silently clear the fleet whenever a data
 *   source was down. `duplicate_unit_reports` learned this the hard way, and its
 *   `resolveStaleReports` shape is copied here on purpose.
 */
const { query } = require('./pool');

const SEVERITIES = ['info', 'warning', 'serious'];
const TIERS = ['auto', 'approval', 'warning'];

function mapFinding(row) {
  if (!row) return null;
  return {
    id: row.id,
    checkKey: row.check_key,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    title: row.title,
    severity: row.severity,
    tier: row.tier,
    evidence: row.evidence_json,
    proposedChange: row.proposed_change_json,
    confidence: row.confidence,
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
    dismissedAt: row.dismissed_at,
    dismissedBy: row.dismissed_by,
    dismissReason: row.dismiss_reason,
    snoozedUntil: row.snoozed_until,
  };
}

/**
 * File a finding, or refresh the one that already describes this condition.
 *
 * The UPDATE deliberately leaves `first_seen_at` alone — "this has been true
 * since June" is the most useful thing a recurring finding knows.
 */
async function upsertFinding(finding, client = null) {
  const run = client ? client.query.bind(client) : query;
  const {
    checkKey, subjectType, subjectId, title,
    severity = 'info', tier = 'warning',
    evidence = {}, proposedChange = null, confidence = null,
  } = finding;

  const res = await run(
    `INSERT INTO operational_findings
       (check_key, subject_type, subject_id, title, severity, tier,
        evidence_json, proposed_change_json, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
     ON CONFLICT (check_key, subject_type, subject_id) DO UPDATE
       SET title = EXCLUDED.title,
           severity = EXCLUDED.severity,
           tier = EXCLUDED.tier,
           evidence_json = EXCLUDED.evidence_json,
           proposed_change_json = EXCLUDED.proposed_change_json,
           confidence = EXCLUDED.confidence,
           last_seen_at = NOW(),
           updated_at = NOW(),
           status = CASE WHEN operational_findings.status = 'resolved'
                         THEN 'open' ELSE operational_findings.status END,
           resolved_at = CASE WHEN operational_findings.status = 'resolved'
                              THEN NULL ELSE operational_findings.resolved_at END
     RETURNING *`,
    [checkKey, subjectType, String(subjectId), title, severity, tier,
      JSON.stringify(evidence ?? {}),
      proposedChange == null ? null : JSON.stringify(proposedChange),
      confidence]
  );
  return mapFinding(res.rows[0]);
}

/**
 * Close the open findings of the checks that RAN this sweep and were not
 * re-reported — i.e. the condition is genuinely gone.
 *
 * Scoped two ways on purpose. `checkKeys` is only the checks that actually
 * completed, so a Samsara outage cannot clear name-mismatch findings it never
 * evaluated. `keepIds` is what the sweep just filed, taken from the ids
 * `upsertFinding` returns, which avoids re-deriving the identity in SQL.
 *
 * @param {string[]} checkKeys  checks that ran to completion this sweep
 * @param {number[]} keepIds    finding ids the sweep just filed or refreshed
 */
async function resolveClearedFindings(checkKeys, keepIds = [], client = null) {
  if (!Array.isArray(checkKeys) || !checkKeys.length) return 0;
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `UPDATE operational_findings
        SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
      WHERE status = 'open'
        AND check_key = ANY($1::text[])
        AND NOT (id = ANY($2::int[]))
      RETURNING id`,
    [checkKeys, keepIds.length ? keepIds : [0]]
  );
  return res.rowCount || 0;
}

async function listFindings({
  status = 'open', severity = null, checkKey = null, tier = null,
  includeSnoozed = false, limit = 200,
} = {}) {
  const res = await query(
    `SELECT * FROM operational_findings
      WHERE ($1::text IS NULL OR status = $1)
        AND ($2::text IS NULL OR severity = $2)
        AND ($3::text IS NULL OR check_key = $3)
        AND ($4::text IS NULL OR tier = $4)
        AND ($5::boolean OR snoozed_until IS NULL OR snoozed_until <= NOW())
      ORDER BY CASE severity WHEN 'serious' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
               last_seen_at DESC
      LIMIT $6`,
    [status, severity, checkKey, tier, includeSnoozed, limit]
  );
  return res.rows.map(mapFinding);
}

/**
 * How many findings match, without fetching them.
 *
 * The auto-apply batch needs a true count for two things it cannot get from a
 * page of rows: the per-check cap it must refuse to exceed (a LIMIT can only
 * ever tell it "at least this many"), and the honest number to put in the
 * finding it files about its own stall.
 *
 * Counts what `listFindings` would return, snooze included: a finding somebody
 * put to one side must not consume a slot in the cap it is not going to use.
 */
async function countFindings({ status = 'open', checkKey = null, tier = null } = {}) {
  const res = await query(
    `SELECT COUNT(*)::int AS n FROM operational_findings
      WHERE ($1::text IS NULL OR status = $1)
        AND ($2::text IS NULL OR check_key = $2)
        AND ($3::text IS NULL OR tier = $3)
        AND (snoozed_until IS NULL OR snoozed_until <= NOW())`,
    [status, checkKey, tier]
  );
  return res.rows[0].n;
}

async function getFindingById(id) {
  const res = await query('SELECT * FROM operational_findings WHERE id = $1', [id]);
  return mapFinding(res.rows[0]);
}

/**
 * Counts for the summary tiles — zero-filled so a severity never vanishes from
 * the page just because nothing currently has it (the VideoRecoveryCard rule).
 */
async function summariseFindings() {
  const res = await query(
    `SELECT severity, COUNT(*)::int AS n
       FROM operational_findings
      WHERE status = 'open'
        AND (snoozed_until IS NULL OR snoozed_until <= NOW())
      GROUP BY severity`
  );
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const row of res.rows) counts[row.severity] = row.n;
  return { ...counts, total: SEVERITIES.reduce((sum, s) => sum + counts[s], 0) };
}

/** Dismiss with a reason. The schema refuses a dismissal without one. */
async function dismissFinding(id, { dismissedBy = null, reason }, client = null) {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `UPDATE operational_findings
        SET status = 'dismissed', dismissed_at = NOW(),
            dismissed_by = $2, dismiss_reason = $3, updated_at = NOW()
      WHERE id = $1 AND status = 'open'
      RETURNING *`,
    [id, dismissedBy, reason]
  );
  return mapFinding(res.rows[0]);
}

/** Hide a real-but-known finding for a while without pretending it went away. */
async function snoozeFinding(id, snoozedUntil, client = null) {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `UPDATE operational_findings
        SET snoozed_until = $2, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, snoozedUntil]
  );
  return mapFinding(res.rows[0]);
}

module.exports = {
  SEVERITIES,
  TIERS,
  mapFinding,
  upsertFinding,
  resolveClearedFindings,
  listFindings,
  countFindings,
  getFindingById,
  summariseFindings,
  dismissFinding,
  snoozeFinding,
};
