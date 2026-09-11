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
    // WHAT ACCEPTING WOULD DO — null means "a person still has to do it", which
    // is most of them and must be said rather than implied.
    applyAction: row.apply_action || null,
    applyPayload: row.apply_payload || null,
    appliedAt: row.applied_at,
    appliedBy: row.applied_by,
    appliedBefore: row.applied_before || null,
    revertedAt: row.reverted_at,
    revertedBy: row.reverted_by,
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
async function upsertSuggestion({
  kind, subjectId, title, suggestion, evidence = {}, applyAction = null,
}) {
  const res = await query(
    `INSERT INTO operational_learning_suggestions
       (kind, subject_id, title, suggestion, evidence, apply_action, apply_payload)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
     ON CONFLICT (kind, subject_id) DO UPDATE
       SET title = EXCLUDED.title,
           suggestion = EXCLUDED.suggestion,
           evidence = EXCLUDED.evidence,
           -- Refreshed with the rest: if the pattern now spans a different set
           -- of checks, what accepting would DO has changed too, and a stale
           -- payload would apply the change to the wrong ones.
           apply_action = EXCLUDED.apply_action,
           apply_payload = EXCLUDED.apply_payload,
           last_seen_at = NOW()
     RETURNING *`,
    [
      kind, String(subjectId), title, suggestion, JSON.stringify(evidence),
      applyAction?.action || null,
      applyAction?.payload ? JSON.stringify(applyAction.payload) : null,
    ]
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

/** Every status a row may hold. `accepted` is legacy — see migration 0040. */
const STATUSES = Object.freeze([
  'proposed', 'accepted', 'accepted_active', 'accepted_manual', 'dismissed', 'reverted',
]);

/**
 * A person's decision.
 *
 * THIS RECORDS THE DECISION AND NOTHING MORE. Whether anything actually changed
 * is decided one layer up, in `services/operations/learningDecision.js`, which
 * runs the registered action when there is one and sets `accepted_active`, or
 * sets `accepted_manual` when there is not. Keeping the write dumb means the
 * status can never claim more than was done.
 */
/**
 * Which statuses `/decide` may move a row OUT of.
 *
 * `accepted_active` is absent, and that is the point. Two administrators can
 * have the same proposal open: one accepts and the setting changes, the other's
 * stale screen then posts `dismissed` or `proposed`. An unconditional update
 * would hide the `accepted_active` state while the setting stayed changed —
 * and since the Undo button lives on that state, the change would become
 * un-undoable from the UI while still being in force. Silently.
 *
 * Reversing an applied suggestion goes through `/revert`, which restores the
 * values it recorded. That is the only path that may leave `accepted_active`.
 */
const DECIDABLE_FROM = Object.freeze(['proposed', 'accepted', 'accepted_manual', 'dismissed', 'reverted']);

async function decideSuggestion(id, { status, decidedBy = null, note = null }) {
  if (!STATUSES.includes(status)) return null;
  const res = await query(
    `UPDATE operational_learning_suggestions
        SET status = $2,
            decided_by = CASE WHEN $2 = 'proposed' THEN NULL ELSE $3 END,
            decided_at = CASE WHEN $2 = 'proposed' THEN NULL ELSE NOW() END,
            decision_note = CASE WHEN $2 = 'proposed' THEN NULL ELSE $4 END,
            last_seen_at = NOW()
      WHERE id = $1
        AND status = ANY($5::text[])
      RETURNING *`,
    [id, status, decidedBy, note, DECIDABLE_FROM]
  );
  return mapRow(res.rows[0]);
}

/**
 * Stamp that an action actually ran, with the values it replaced.
 *
 * `before` is the whole point: a revert must restore what was THERE, not a
 * default somebody assumed was there.
 */
async function recordSuggestionApplied(id, { action, before, appliedBy }, client = null) {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `UPDATE operational_learning_suggestions
        SET status = 'accepted_active',
            apply_action = COALESCE($2, apply_action),
            applied_at = NOW(),
            applied_by = $3,
            applied_before = $4::jsonb,
            reverted_at = NULL,
            reverted_by = NULL,
            last_seen_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, action || null, appliedBy, JSON.stringify(before ?? {})]
  );
  return mapRow(res.rows[0]);
}

/** Undone. `applied_before` is deliberately KEPT — it is the record of what was. */
async function recordSuggestionReverted(id, { revertedBy, note = null }, client = null) {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `UPDATE operational_learning_suggestions
        SET status = 'reverted',
            reverted_at = NOW(),
            reverted_by = $2,
            decision_note = COALESCE($3, decision_note),
            last_seen_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, revertedBy, note]
  );
  return mapRow(res.rows[0]);
}

async function getSuggestionById(id) {
  const res = await query('SELECT * FROM operational_learning_suggestions WHERE id = $1', [id]);
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
    // EVERY ACCEPTED STATUS COUNTS AS AGREED. The vocabulary gained
    // `accepted_active` and `accepted_manual`, which are what every acceptance
    // now produces — counting only the legacy `accepted` left the Learning
    // tab's "agreed" total sitting at zero immediately after an administrator
    // accepted something, which reads as the click having done nothing. That is
    // the exact impression the whole change was written to remove.
    `SELECT COUNT(*) FILTER (WHERE status = 'proposed')::int AS proposed,
            COUNT(*) FILTER (WHERE status IN ('accepted', 'accepted_active', 'accepted_manual'))::int AS accepted,
            -- Split out too, because "agreed and the setting changed" and
            -- "agreed, somebody still has to do it" are different states of the
            -- world and the screen shows them differently.
            COUNT(*) FILTER (WHERE status = 'accepted_active')::int AS active,
            COUNT(*) FILTER (WHERE status = 'accepted_manual')::int AS awaiting_a_person,
            COUNT(*) FILTER (WHERE status = 'reverted')::int AS reverted,
            COUNT(*) FILTER (WHERE status = 'dismissed')::int AS dismissed
       FROM operational_learning_suggestions`
  );
  const r = res.rows[0] || {};
  return {
    proposed: r.proposed || 0,
    accepted: r.accepted || 0,
    active: r.active || 0,
    awaitingAPerson: r.awaiting_a_person || 0,
    reverted: r.reverted || 0,
    dismissed: r.dismissed || 0,
  };
}

module.exports = {
  STATUSES,
  DECIDABLE_FROM,
  recordSuggestionApplied,
  recordSuggestionReverted,
  getSuggestionById,
  mapRow,
  upsertSuggestion,
  markSuggestionNotified,
  decideSuggestion,
  listSuggestions,
  summariseSuggestions,
};
