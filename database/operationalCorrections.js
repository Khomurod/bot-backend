/**
 * Reading the correction trail — what the system changed, and whether it stands.
 *
 * Stage 3 gave `operational_corrections` a writer and no reader: `apply.js`
 * inserts a row inside the same transaction as the change it records, and
 * nothing has ever asked what is in there. The History tab is that reader, and
 * so is any operator asking the two questions that actually get asked — "what
 * has been done about this finding?" and "what has been done to this driver?"
 *
 * Two things this module deliberately does NOT do.
 *
 *   IT DOES NOT WRITE. Applying and reverting live in
 *   `services/operations/corrections/apply.js`, because both must happen in one
 *   transaction with the fleet change and the audit row. A convenience writer
 *   here would be a second way to record a correction, and the second way is
 *   always the one that forgets the audit mirror.
 *
 *   IT DOES NOT RE-DERIVE. `old_values`, `new_values` and `affected_records`
 *   are read back exactly as they were stored. The whole point of storing the
 *   complete before-image was that a reader years later must not depend on code
 *   that has changed since to reconstruct it.
 */
const { query } = require('./pool');

function mapCorrection(row) {
  if (!row) return null;
  return {
    id: row.id,
    findingId: row.finding_id,
    actionKey: row.action_key,
    tier: row.tier,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    oldValues: row.old_values,
    newValues: row.new_values,
    affectedRecords: row.affected_records,
    confidence: row.confidence,
    initiator: row.initiator,
    reason: row.reason,
    appliedAt: row.applied_at,
    revertedAt: row.reverted_at,
    revertedBy: row.reverted_by,
    revertReason: row.revert_reason,
    // Still in effect? The question every row in the History tab is really
    // asking, answered once here rather than by every caller re-deriving it.
    live: row.reverted_at == null,
    // Present only on the joined list, hence the null-safe reads: a correction
    // outlives its finding on purpose (ON DELETE SET NULL).
    findingTitle: row.finding_title ?? null,
    checkKey: row.check_key ?? null,
    findingSeverity: row.finding_severity ?? null,
  };
}

/**
 * The History tab: newest first, with each correction's finding alongside it.
 *
 * `live` filters to corrections still in effect; `subjectType`/`subjectId`
 * answer "what has been done to this driver". LEFT JOIN, never INNER — a
 * correction whose finding was cleaned up is still a change that was made to
 * the fleet, and dropping it from history would be the trail lying by omission.
 */
async function listCorrections({
  actionKey = null, subjectType = null, subjectId = null,
  live = null, findingId = null, limit = 100, offset = 0,
} = {}) {
  const res = await query(
    `SELECT c.*, f.title AS finding_title, f.check_key, f.severity AS finding_severity
       FROM operational_corrections c
       LEFT JOIN operational_findings f ON f.id = c.finding_id
      WHERE ($1::text IS NULL OR c.action_key = $1)
        AND ($2::text IS NULL OR c.subject_type = $2)
        AND ($3::text IS NULL OR c.subject_id = $3)
        AND ($4::boolean IS NULL
             OR ($4 IS TRUE AND c.reverted_at IS NULL)
             OR ($4 IS FALSE AND c.reverted_at IS NOT NULL))
        AND ($5::int IS NULL OR c.finding_id = $5)
      ORDER BY c.applied_at DESC, c.id DESC
      LIMIT $6 OFFSET $7`,
    [actionKey, subjectType, subjectId, live, findingId, limit, offset]
  );
  return res.rows.map(mapCorrection);
}

async function getCorrectionById(id) {
  const res = await query(
    `SELECT c.*, f.title AS finding_title, f.check_key, f.severity AS finding_severity
       FROM operational_corrections c
       LEFT JOIN operational_findings f ON f.id = c.finding_id
      WHERE c.id = $1`,
    [id]
  );
  return mapCorrection(res.rows[0]);
}

/**
 * Counts for the History tiles, zero-filled.
 *
 * Zero-filled for the reason the VideoRecoveryCard is: a tile that disappears
 * when its count reaches zero reads as "this feature is broken", not as "there
 * is nothing to report", and an operator cannot tell those apart at a glance.
 */
async function summariseCorrections({ sinceIso = null } = {}) {
  const res = await query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE reverted_at IS NULL)::int AS live,
            COUNT(*) FILTER (WHERE reverted_at IS NOT NULL)::int AS reverted,
            COUNT(*) FILTER (WHERE initiator = 'system')::int AS by_system,
            COUNT(*) FILTER (WHERE initiator <> 'system')::int AS by_admin
       FROM operational_corrections
      WHERE ($1::timestamptz IS NULL OR applied_at >= $1)`,
    [sinceIso]
  );
  const r = res.rows[0];
  return {
    total: r.total, live: r.live, reverted: r.reverted,
    bySystem: r.by_system, byAdmin: r.by_admin,
  };
}

/**
 * The audit rows behind a correction — the log's first reader since it was
 * created.
 *
 * Matched on the same `(entity_type, entity_id)` the correction wrote, and
 * scoped to `operational_correction.%` actions so an unrelated edit to the same
 * driver does not appear as part of this correction's story.
 */
async function listAuditForSubject({ entityType, entityId, limit = 50 } = {}) {
  const res = await query(
    `SELECT a.id, a.admin_id, a.role_keys, a.action, a.entity_type, a.entity_id,
            a.old_values, a.new_values, a.reason, a.ip_address, a.created_at,
            ad.username
       FROM admin_audit_log a
       LEFT JOIN admins ad ON ad.id = a.admin_id
      WHERE a.entity_type = $1 AND a.entity_id = $2
        AND a.action LIKE 'operational_correction.%'
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $3`,
    [entityType, String(entityId), limit]
  );
  return res.rows;
}

module.exports = {
  mapCorrection,
  listCorrections,
  getCorrectionById,
  summariseCorrections,
  listAuditForSubject,
};
