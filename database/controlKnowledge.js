/**
 * What the owner has already told Wenze about a condition.
 *
 * WHY THIS IS NOT "a dismissed finding stays dismissed". A finding is
 * re-derived from live rows on every sweep and re-filed with a NEW id, so its
 * own `status` cannot carry an answer forward. This table does, and it is keyed
 * on `(check_key, subject_type, subject_id)` for exactly that reason.
 *
 * THE FINGERPRINT IS THE SAFETY RULE, and it lives one layer down in
 * `lib/control/fingerprint.js`. A row here says WHAT was answered; whether that
 * answer still applies is decided by comparing the fingerprint of the condition
 * in front of us now with the one recorded here. This module never makes that
 * comparison — it stores and returns, and the ask pass decides.
 *
 * A REMEMBERED "YES" IS NEVER RE-APPLIED. `answer_action` may be `approve` and
 * the ask pass reads it as context; `actsFromMemory` in the pure module is what
 * says only `dismiss` and `snooze` may act. Stated here as well because this is
 * where somebody adding a feature would look first.
 */
const { query } = require('./pool');

const MAX_TEXT = 1000;

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    checkKey: row.check_key,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    answerAction: row.answer_action,
    answerText: row.answer_text || null,
    evidenceFingerprint: row.evidence_fingerprint,
    confirmedBy: row.confirmed_by || null,
    replyId: row.reply_id == null ? null : Number(row.reply_id),
    timesApplied: Number(row.times_applied || 0),
    lastAppliedAt: row.last_applied_at || null,
    expiresAt: row.expires_at || null,
    revokedAt: row.revoked_at || null,
    revokedBy: row.revoked_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Record — or replace — what the owner said about this condition.
 *
 * A SECOND ANSWER REPLACES THE FIRST, and clears any revocation. The owner
 * answering again is the owner changing their mind, and the newest answer is
 * the one they meant. `times_applied` resets with it: the count belongs to the
 * answer, not to the subject.
 */
async function rememberAnswer({
  checkKey, subjectType, subjectId, answerAction, answerText = null,
  evidenceFingerprint, confirmedBy = null, replyId = null, expiresAt = null,
}) {
  const res = await query(
    `INSERT INTO control_knowledge
       (check_key, subject_type, subject_id, answer_action, answer_text,
        evidence_fingerprint, confirmed_by, reply_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (check_key, subject_type, subject_id) DO UPDATE
        SET answer_action = EXCLUDED.answer_action,
            answer_text = EXCLUDED.answer_text,
            evidence_fingerprint = EXCLUDED.evidence_fingerprint,
            confirmed_by = EXCLUDED.confirmed_by,
            reply_id = EXCLUDED.reply_id,
            expires_at = EXCLUDED.expires_at,
            times_applied = 0,
            last_applied_at = NULL,
            revoked_at = NULL,
            revoked_by = NULL,
            updated_at = NOW()
      RETURNING *`,
    [
      String(checkKey), String(subjectType), String(subjectId),
      String(answerAction),
      answerText == null ? null : String(answerText).slice(0, MAX_TEXT),
      String(evidenceFingerprint),
      confirmedBy == null ? null : String(confirmedBy),
      replyId == null ? null : Number(replyId),
      expiresAt || null,
    ]
  );
  return mapRow(res.rows[0]);
}

/**
 * What is remembered about this exact subject.
 *
 * Revoked rows are excluded here rather than filtered by the caller: a revoked
 * memory must not be able to act through a caller that forgot to check.
 * Expiry is NOT applied in SQL — `memoryApplies` owns that comparison so there
 * is one clock, and a test can move it.
 */
async function findMemory({ checkKey, subjectType, subjectId }) {
  try {
    const res = await query(
      `SELECT * FROM control_knowledge
        WHERE check_key = $1 AND subject_type = $2 AND subject_id = $3
          AND revoked_at IS NULL
        LIMIT 1`,
      [String(checkKey), String(subjectType), String(subjectId)]
    );
    return mapRow(res.rows[0]);
  } catch (_) {
    // The ask pass runs before this table exists on a database that has not
    // taken migration 0050 yet. Not knowing anything is the correct degraded
    // behaviour — it asks, which is noisy and safe.
    return null;
  }
}

/** Every live memory for one check, for the ask pass's per-pass lookup. */
async function listMemoriesForChecks(checkKeys = []) {
  const keys = [...new Set((checkKeys || []).map(String).filter(Boolean))];
  if (!keys.length) return [];
  try {
    const res = await query(
      `SELECT * FROM control_knowledge
        WHERE check_key = ANY($1::text[]) AND revoked_at IS NULL`,
      [keys]
    );
    return res.rows.map(mapRow);
  } catch (_) {
    return [];
  }
}

/** One memory just decided a finding again. */
async function noteApplied(id) {
  const res = await query(
    `UPDATE control_knowledge
        SET times_applied = times_applied + 1,
            last_applied_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING *`,
    [Number(id)]
  );
  return mapRow(res.rows[0]);
}

/**
 * Take a memory back.
 *
 * The row stays. "Wenze used to stop asking about this because you said X, and
 * you withdrew that on the 3rd" is worth keeping; a DELETE would leave the
 * behaviour change unexplained.
 */
async function revokeMemory(id, { revokedBy = null } = {}) {
  const res = await query(
    `UPDATE control_knowledge
        SET revoked_at = NOW(), revoked_by = $2, updated_at = NOW()
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING *`,
    [Number(id), revokedBy == null ? null : String(revokedBy)]
  );
  return mapRow(res.rows[0]);
}

/** The admin's list: what Wenze is currently remembering. */
async function listMemories({ limit = 100, includeRevoked = false } = {}) {
  try {
    const res = await query(
      `SELECT * FROM control_knowledge
        ${includeRevoked ? '' : 'WHERE revoked_at IS NULL'}
        ORDER BY created_at DESC
        LIMIT $1`,
      [Math.max(1, Math.min(500, Number(limit) || 100))]
    );
    return res.rows.map(mapRow);
  } catch (_) {
    return [];
  }
}

/** Counts only, for /api/health. No answer text ever leaves this function. */
async function summariseKnowledge() {
  try {
    const res = await query(
      `SELECT COUNT(*) FILTER (WHERE revoked_at IS NULL)::int AS live,
              COUNT(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked,
              COALESCE(SUM(times_applied) FILTER (WHERE revoked_at IS NULL), 0)::int AS applied,
              MAX(last_applied_at) AS last_applied_at
         FROM control_knowledge`
    );
    const r = res.rows[0] || {};
    return {
      available: true,
      live: r.live || 0,
      revoked: r.revoked || 0,
      applied: r.applied || 0,
      lastAppliedAt: r.last_applied_at || null,
    };
  } catch (_) {
    return { available: false, live: 0, revoked: 0, applied: 0, lastAppliedAt: null };
  }
}

module.exports = {
  MAX_TEXT,
  rememberAnswer,
  findMemory,
  listMemoriesForChecks,
  noteApplied,
  revokeMemory,
  listMemories,
  summariseKnowledge,
};
