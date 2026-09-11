'use strict';

/**
 * What Wenze decided — including every time it decided to do nothing.
 *
 * `operational_corrections` records changes. This records DECISIONS, which is a
 * larger and more useful set: the holds, the "I do not know yet"s, and the
 * things Shadow mode would have done. A system that records only its successes
 * cannot learn from restraint, and restraint is most of what this one does.
 *
 * BOUNDED BY ITS KEY, and the arithmetic is in migration 0043. A row per
 * decision per pass costs about 44,000 rows a day; keyed on
 * (check, subject, verdict) it costs a few tens of thousands FOR EVER, because
 * the same verdict recurring counts itself in one row. A change of verdict
 * writes another — that is the signal, not the noise.
 */
const { query } = require('./db');

const VALID_VERDICTS = new Set(['act', 'suggest', 'hold', 'unknown']);
const VALID_OUTCOMES = new Set(['confirmed', 'contradicted', 'reverted', 'expired', 'not_checked']);
/** Keep a reason readable and bounded; it is shown on a screen, not parsed. */
const MAX_REASON = 500;

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    checkKey: row.check_key,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    personId: row.person_id == null ? null : Number(row.person_id),
    verdict: row.verdict,
    confidence: row.confidence == null ? null : Number(row.confidence),
    mode: row.mode,
    shadow: row.shadow === true,
    reason: row.reason,
    evidence: row.evidence || {},
    sources: row.sources || [],
    actionKey: row.action_key,
    correctionId: row.correction_id == null ? null : Number(row.correction_id),
    wouldHave: row.would_have,
    outcome: row.outcome,
    outcomeAt: row.outcome_at,
    outcomeDetail: row.outcome_detail,
    firstDecidedAt: row.first_decided_at,
    lastDecidedAt: row.last_decided_at,
    timesDecided: Number(row.times_decided),
  };
}

/**
 * Record a decision, or count another occurrence of the same one.
 *
 * Never throws. A journal that can break the decision it is recording is worse
 * than no journal — the same rule the run ledger follows, for the same reason.
 *
 * @returns {Promise<object|null>} the row, or null if it could not be written
 */
async function recordDecision({
  checkKey, subjectType, subjectId, personId = null,
  verdict, confidence = null, mode = 'suggest', shadow = false,
  reason, evidence = {}, sources = [],
  actionKey = null, correctionId = null, wouldHave = null,
} = {}) {
  if (!checkKey || !subjectType || subjectId == null || !VALID_VERDICTS.has(verdict)) return null;
  // "I do not know" may not carry a confidence. The schema refuses it too; this
  // is here so a caller gets the coercion rather than an exception.
  const score = verdict === 'unknown' ? null
    : (Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence))) : null);
  try {
    const res = await query(
      `INSERT INTO operational_decisions
         (check_key, subject_type, subject_id, person_id, verdict, confidence, mode,
          shadow, reason, evidence, sources, action_key, correction_id, would_have)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14::jsonb)
       ON CONFLICT (check_key, subject_type, subject_id, verdict) DO UPDATE SET
         last_decided_at = NOW(),
         times_decided = operational_decisions.times_decided + 1,
         -- The LATEST reading of each, because a decision reached again on
         -- fresher evidence is the same decision better supported.
         confidence = EXCLUDED.confidence,
         mode = EXCLUDED.mode,
         shadow = EXCLUDED.shadow,
         reason = EXCLUDED.reason,
         evidence = EXCLUDED.evidence,
         sources = EXCLUDED.sources,
         person_id = COALESCE(EXCLUDED.person_id, operational_decisions.person_id),
         action_key = COALESCE(EXCLUDED.action_key, operational_decisions.action_key),
         correction_id = COALESCE(EXCLUDED.correction_id, operational_decisions.correction_id),
         would_have = EXCLUDED.would_have
       RETURNING *`,
      [
        String(checkKey), String(subjectType), String(subjectId),
        personId == null ? null : Number(personId),
        verdict, score, String(mode), shadow === true,
        String(reason || '').slice(0, MAX_REASON),
        JSON.stringify(evidence || {}), JSON.stringify(sources || []),
        actionKey, correctionId == null ? null : Number(correctionId),
        wouldHave ? JSON.stringify(wouldHave) : null,
      ]
    );
    return mapRow(res.rows[0]);
  } catch (err) {
    console.warn('[DECISIONS] could not record:', err.message);
    return null;
  }
}

/**
 * Grade a decision after the fact.
 *
 * Called by the verification pass, never by the decider — a decision that
 * graded its own homework would be worth nothing.
 */
async function recordOutcome(id, outcome, detail = null) {
  if (!id || !VALID_OUTCOMES.has(outcome)) return false;
  try {
    const res = await query(
      `UPDATE operational_decisions
          SET outcome = $2, outcome_at = NOW(), outcome_detail = $3
        WHERE id = $1`,
      [Number(id), outcome, detail ? String(detail).slice(0, MAX_REASON) : null]
    );
    return res.rowCount > 0;
  } catch (_) {
    return false;
  }
}

/** Decisions that acted and have not been graded yet — the verifier's queue. */
async function listUnverifiedActions({ olderThanMinutes = 30, limit = 100 } = {}) {
  try {
    const res = await query(
      `SELECT * FROM operational_decisions
        WHERE outcome IS NULL AND action_key IS NOT NULL AND verdict = 'act'
          AND last_decided_at < NOW() - ($1 || ' minutes')::interval
        ORDER BY last_decided_at ASC LIMIT $2`,
      [String(Math.max(0, olderThanMinutes)), Math.max(1, Math.min(500, limit))]
    );
    return res.rows.map(mapRow);
  } catch (_) {
    return [];
  }
}

async function listRecentDecisions({ checkKey = null, verdict = null, limit = 100 } = {}) {
  try {
    const res = await query(
      `SELECT * FROM operational_decisions
        WHERE ($1::text IS NULL OR check_key = $1)
          AND ($2::text IS NULL OR verdict = $2)
        ORDER BY last_decided_at DESC LIMIT $3`,
      [checkKey, verdict, Math.max(1, Math.min(500, limit))]
    );
    return res.rows.map(mapRow);
  } catch (_) {
    return [];
  }
}

/**
 * What it has been deciding, and how those decisions turned out.
 *
 * `unknown` is counted SEPARATELY from `hold` at every level here. Folding them
 * together would hide the one number that says whether this system can see:
 * a week of `unknown` is a data problem, a week of `hold` is a quiet fleet.
 */
async function summariseDecisions({ sinceHours = 168 } = {}) {
  try {
    const res = await query(
      `SELECT verdict, outcome, COUNT(*)::int AS n, SUM(times_decided)::bigint AS occurrences
         FROM operational_decisions
        WHERE last_decided_at > NOW() - ($1 || ' hours')::interval
        GROUP BY verdict, outcome`,
      [String(Math.max(1, sinceHours))]
    );
    const byVerdict = {};
    const byOutcome = {};
    let total = 0;
    let occurrences = 0;
    for (const row of res.rows) {
      byVerdict[row.verdict] = (byVerdict[row.verdict] || 0) + row.n;
      if (row.outcome) byOutcome[row.outcome] = (byOutcome[row.outcome] || 0) + row.n;
      total += row.n;
      occurrences += Number(row.occurrences || 0);
    }
    return { available: true, total, occurrences, byVerdict, byOutcome };
  } catch (_) {
    return { available: false, total: 0, occurrences: 0, byVerdict: {}, byOutcome: {} };
  }
}

/** Old decisions nobody will read. Never touches one still awaiting its outcome. */
async function pruneDecisions({ olderThanDays = 90 } = {}) {
  try {
    const res = await query(
      `DELETE FROM operational_decisions
        WHERE last_decided_at < NOW() - ($1 || ' days')::interval
          AND (outcome IS NOT NULL OR action_key IS NULL)`,
      [String(Math.max(1, olderThanDays))]
    );
    return res.rowCount;
  } catch (_) {
    return 0;
  }
}

module.exports = {
  VALID_VERDICTS,
  VALID_OUTCOMES,
  recordDecision,
  recordOutcome,
  listUnverifiedActions,
  listRecentDecisions,
  summariseDecisions,
  pruneDecisions,
};
