'use strict';

/**
 * Suggestions Wenze has made about its own rules, and what a person decided.
 *
 * NOTHING HERE CAN APPLY ANYTHING. There is no column holding a setting to
 * change, no action key to execute, and no status meaning "done automatically".
 * A suggestion is a sentence and a piece of evidence; an administrator agrees
 * or does not. Important business rules must not change permanently without
 * somebody confirming, and the cheapest way to keep that true is to give the
 * machine nowhere to write the change.
 *
 * Deduped on `(kind, subject_id)` so a pattern that persists across passes
 * updates one row. The same shape as `operational_findings`, and for the same
 * reason: a recurring condition is one thing to look at, not a hundred.
 */
const { query } = require('./pool');

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    subjectId: row.subject_id,
    title: row.title,
    suggestion: row.suggestion,
    evidence: row.evidence || {},
    status: row.status,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    notifiedAt: row.notified_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * Record a suggestion, or refresh one that is still true.
 *
 * A suggestion a person has already DECIDED is not reopened — the title and
 * evidence are refreshed so the record stays accurate, but `status` is left
 * alone. Reopening it would mean an administrator who dismissed a suggestion
 * saw it again every fortnight, which is how somebody stops reading them.
 */
async function upsertSuggestion({ kind, subjectId, title, suggestion, evidence = {} }) {
  const res = await query(
    `INSERT INTO operational_learning_suggestions
       (kind, subject_id, title, suggestion, evidence)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (kind, subject_id) DO UPDATE
       SET title = EXCLUDED.title,
           suggestion = EXCLUDED.suggestion,
           evidence = EXCLUDED.evidence,
           last_seen_at = NOW()
     RETURNING *`,
    [kind, String(subjectId), title, suggestion, JSON.stringify(evidence)]
  );
  return mapRow(res.rows[0]);
}

/** Stamp that it was announced, so the next pass does not announce it again. */
async function markSuggestionNotified(id) {
  const res = await query(
    `UPDATE operational_learning_suggestions
        SET notified_at = NOW(), last_seen_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id]
  );
  return mapRow(res.rows[0]);
}

/**
 * A person's decision. `accepted` records agreement; it does not CAUSE
 * anything — whatever the suggestion proposed is still done by hand, on
 * purpose, because the alternative is a machine changing a business rule
 * because it convinced itself.
 */
async function decideSuggestion(id, { status, decidedBy = null, note = null }) {
  if (!['accepted', 'dismissed', 'proposed'].includes(status)) return null;
  const res = await query(
    `UPDATE operational_learning_suggestions
        SET status = $2,
            decided_by = CASE WHEN $2 = 'proposed' THEN NULL ELSE $3 END,
            decided_at = CASE WHEN $2 = 'proposed' THEN NULL ELSE NOW() END,
            decision_note = CASE WHEN $2 = 'proposed' THEN NULL ELSE $4 END,
            last_seen_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, status, decidedBy, note]
  );
  return mapRow(res.rows[0]);
}

async function listSuggestions({ status = null, limit = 50 } = {}) {
  const values = [];
  const clauses = [];
  if (status) { values.push(status); clauses.push(`status = $${values.length}`); }
  values.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  const res = await query(
    `SELECT * FROM operational_learning_suggestions
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY last_seen_at DESC
      LIMIT $${values.length}`,
    values
  );
  return res.rows.map(mapRow);
}

async function summariseSuggestions() {
  const res = await query(
    `SELECT COUNT(*) FILTER (WHERE status = 'proposed')::int AS proposed,
            COUNT(*) FILTER (WHERE status = 'accepted')::int AS accepted,
            COUNT(*) FILTER (WHERE status = 'dismissed')::int AS dismissed
       FROM operational_learning_suggestions`
  );
  return res.rows[0] || { proposed: 0, accepted: 0, dismissed: 0 };
}

module.exports = {
  mapRow,
  upsertSuggestion,
  markSuggestionNotified,
  decideSuggestion,
  listSuggestions,
  summariseSuggestions,
};
