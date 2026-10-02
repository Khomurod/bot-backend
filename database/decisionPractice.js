'use strict';

/**
 * Each check's rehearsal record, for lib/operations/practiceReadiness.js.
 *
 * A rehearsal is a decision the evidence supported that was NOT carried out:
 *   `suggest`              the check is in Suggest mode — `applyMode` turns a
 *                          supported decision into `suggest`, never `act`, so
 *                          an `act` row can NEVER come from this mode;
 *   `act` with shadow      the check is on Autopilot in shadow.
 * (Observe narrows to `hold`, indistinguishable from evidence that did not
 * support acting, and is deliberately not counted — see
 * services/operations/corrections/rehearsals.js.)
 *
 * Read-only, one statement, counted per check over a window:
 *   subjects   different things it would have acted on
 *   flips      of those, how many it later held or could not decide on
 *   rejected   how many a PERSON dismissed (the finding, with a name on it)
 *   confirmed  how many a PERSON put right with the same kind of correction
 */
const { query } = require('./pool');

async function summarisePractice({ sinceDays = 30 } = {}) {
  const res = await query(
    `WITH acts AS (
       SELECT check_key, subject_type, subject_id, first_decided_at, last_decided_at
         FROM operational_decisions
        WHERE (verdict = 'suggest' OR (verdict = 'act' AND shadow = TRUE))
          AND last_decided_at > NOW() - ($1 || ' days')::interval
     ),
     flips AS (
       SELECT DISTINCT a.check_key, a.subject_type, a.subject_id
         FROM acts a
         JOIN operational_decisions d
           ON d.check_key = a.check_key AND d.subject_type = a.subject_type
          AND d.subject_id = a.subject_id
          AND d.verdict IN ('hold', 'unknown')
          AND d.last_decided_at > a.first_decided_at
     ),
     rejected AS (
       SELECT DISTINCT a.check_key, a.subject_type, a.subject_id
         FROM acts a
         JOIN operational_findings f
           ON f.check_key = a.check_key AND f.subject_type = a.subject_type
          AND f.subject_id = a.subject_id
        WHERE f.status = 'dismissed' AND f.dismissed_by IS NOT NULL
     ),
     confirmed AS (
       SELECT DISTINCT a.check_key, a.subject_type, a.subject_id
         FROM acts a
         JOIN operational_findings f
           ON f.check_key = a.check_key AND f.subject_type = a.subject_type
          AND f.subject_id = a.subject_id
         JOIN operational_corrections c ON c.finding_id = f.id
        WHERE c.initiator <> 'system' AND c.reverted_at IS NULL
     )
     SELECT a.check_key,
            COUNT(*)::int AS subjects,
            MIN(a.first_decided_at) AS first_at,
            MAX(a.last_decided_at) AS last_at,
            (SELECT COUNT(*) FROM flips x WHERE x.check_key = a.check_key)::int AS flips,
            (SELECT COUNT(*) FROM rejected x WHERE x.check_key = a.check_key)::int AS rejected,
            (SELECT COUNT(*) FROM confirmed x WHERE x.check_key = a.check_key)::int AS confirmed
       FROM acts a
      GROUP BY a.check_key
      ORDER BY a.check_key`,
    [String(Math.max(1, Number(sinceDays) || 30))]
  );
  return res.rows.map((r) => ({
    checkKey: r.check_key,
    subjects: r.subjects,
    flips: r.flips,
    rejected: r.rejected,
    confirmed: r.confirmed,
    firstAt: r.first_at,
    lastAt: r.last_at,
  }));
}

module.exports = { summarisePractice };
