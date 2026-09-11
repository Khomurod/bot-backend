'use strict';

/**
 * What Wenze last believed about each driver's risk, and what it has already
 * said out loud.
 *
 * The assessment is recomputed every sweep and could be thrown away. This table
 * exists for three things a stateless computation cannot do: say it once, say
 * it AGAIN when it gets worse, and show a list.
 *
 * "SAY IT AGAIN WHEN IT GETS WORSE" IS THE WHOLE DESIGN. A driver five weeks
 * past the allowance is five weeks past the allowance on every sweep; announcing
 * that every fifteen minutes is how a channel becomes unread. But a score that
 * climbs from 4 to 9 — because they have now said something about leaving — is
 * news even though they were already flagged. `shouldNotify` below is that
 * judgement and it is the only interesting function here.
 */
const { query } = require('./pool');

/** How much worse it has to get before it is worth repeating. */
const RISE_TO_REPEAT = 3;
/** And how long before the same level is worth saying again regardless. */
const REPEAT_AFTER_HOURS = 7 * 24;

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    personId: row.person_id,
    groupId: row.group_id,
    driverName: row.driver_name,
    score: Number(row.score || 0),
    level: row.level,
    signals: Array.isArray(row.signals) ? row.signals : [],
    actions: Array.isArray(row.actions) ? row.actions : [],
    notifiedAt: row.notified_at,
    notifiedScore: row.notified_score === null ? null : Number(row.notified_score),
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * Record this pass's assessment, keeping whatever has already been announced.
 *
 * Two upserts rather than one because a person and a group are ALTERNATIVE
 * identities, not a pair: the partial unique indexes are on `person_id` alone
 * and on `group_id` where there is no person, and a single ON CONFLICT clause
 * cannot name two of them.
 */
async function recordAssessment({
  personId = null, groupId = null, driverName = null, score = 0, level = 'none',
  signals = [], actions = [],
}) {
  const values = [
    personId, groupId, driverName, score, level,
    JSON.stringify(signals), JSON.stringify(actions),
  ];
  const conflict = personId
    ? '(person_id) WHERE person_id IS NOT NULL'
    : '(group_id) WHERE person_id IS NULL AND group_id IS NOT NULL';

  const res = await query(
    `INSERT INTO driver_retention_assessments
       (person_id, group_id, driver_name, score, level, signals, actions)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
     ON CONFLICT ${conflict} DO UPDATE
       SET group_id = COALESCE(EXCLUDED.group_id, driver_retention_assessments.group_id),
           driver_name = COALESCE(EXCLUDED.driver_name, driver_retention_assessments.driver_name),
           score = EXCLUDED.score,
           level = EXCLUDED.level,
           signals = EXCLUDED.signals,
           actions = EXCLUDED.actions,
           last_seen_at = NOW()
     RETURNING *`,
    values
  );
  return mapRow(res.rows[0]);
}

/**
 * Is this worth telling somebody, given what they were already told?
 *
 * Pure, and exported so it can be tested without a database.
 *
 * @param {object|null} previous the stored assessment before this pass
 * @param {{score: number, level: string}} current
 */
function shouldNotify(previous, current, { now = null, riseToRepeat = RISE_TO_REPEAT,
  repeatAfterHours = REPEAT_AFTER_HOURS } = {}) {
  if (current.level === 'none') return { notify: false, reason: 'below_threshold' };
  if (!previous || !previous.notifiedAt) return { notify: true, reason: 'first_time' };

  // An operator has said "we know". Nothing more until it gets materially
  // worse than the point at which they acknowledged it — otherwise the
  // acknowledgement buys silence for a situation that is deteriorating.
  const ackFloor = previous.acknowledgedAt ? (previous.notifiedScore ?? 0) : null;
  if (ackFloor !== null && current.score < ackFloor + riseToRepeat) {
    return { notify: false, reason: 'acknowledged' };
  }

  const rise = current.score - (previous.notifiedScore ?? 0);
  if (rise >= riseToRepeat) return { notify: true, reason: 'got_worse' };

  const nowMs = now ? new Date(now).getTime() : Date.now();
  const lastMs = new Date(previous.notifiedAt).getTime();
  if (Number.isFinite(lastMs) && nowMs - lastMs >= repeatAfterHours * 3600 * 1000) {
    return { notify: true, reason: 'still_true' };
  }

  return { notify: false, reason: 'said_recently' };
}

/** Stamp what was announced, and at what score. */
async function markNotified(id, score) {
  const res = await query(
    `UPDATE driver_retention_assessments
        SET notified_at = NOW(), notified_score = $2, last_seen_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, score]
  );
  return mapRow(res.rows[0]);
}

/** "We know, we are on it." Reversible by passing null. */
async function acknowledge(id, by = null) {
  const res = await query(
    `UPDATE driver_retention_assessments
        SET acknowledged_at = CASE WHEN $2::text IS NULL THEN NULL ELSE NOW() END,
            acknowledged_by = $2,
            last_seen_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, by]
  );
  return mapRow(res.rows[0]);
}

/** The list an operator reads. Worst first. */
async function listAssessments({ level = null, limit = 50 } = {}) {
  const values = [];
  const clauses = ["level <> 'none'"];
  if (level) { values.push(level); clauses.push(`level = $${values.length}`); }
  values.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  const res = await query(
    `SELECT * FROM driver_retention_assessments
      WHERE ${clauses.join(' AND ')}
      ORDER BY score DESC, last_seen_at DESC
      LIMIT $${values.length}`,
    values
  );
  return res.rows.map(mapRow);
}

async function getAssessment({ personId = null, groupId = null }) {
  const res = personId
    ? await query('SELECT * FROM driver_retention_assessments WHERE person_id = $1', [personId])
    : await query(
      'SELECT * FROM driver_retention_assessments WHERE person_id IS NULL AND group_id = $1',
      [groupId]
    );
  return mapRow(res.rows[0]);
}

/** Tiles for the screen and for /api/health. */
async function summariseRetention() {
  const res = await query(
    `SELECT COUNT(*) FILTER (WHERE level = 'urgent')::int AS urgent,
            COUNT(*) FILTER (WHERE level = 'watch')::int AS watch,
            COUNT(*) FILTER (WHERE acknowledged_at IS NOT NULL AND level <> 'none')::int AS acknowledged,
            MAX(last_seen_at) AS last_pass_at
       FROM driver_retention_assessments`
  );
  return res.rows[0] || { urgent: 0, watch: 0, acknowledged: 0, lastPassAt: null };
}

module.exports = {
  RISE_TO_REPEAT,
  REPEAT_AFTER_HOURS,
  mapRow,
  recordAssessment,
  shouldNotify,
  markNotified,
  acknowledge,
  listAssessments,
  getAssessment,
  summariseRetention,
};
