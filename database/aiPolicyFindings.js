/**
 * What changed, why it mattered, and whether anyone has been told.
 *
 * Split from `database/aiPolicy.js` by responsibility rather than by size: that
 * module is about WATCHING (sources, snapshots, settings), this one is about
 * the OUTCOME (findings and their alerts). They are read by different screens
 * and written at different moments.
 *
 * The alert outbox here is the same durable shape as
 * `database/homeTimeInternalAlertOutbox.js` — and it exists in that shape
 * because of what happened to that one: 101 alerts failed against a mistyped
 * chat id, every one exhausted its attempts, and nothing ever told a human. So
 * attempts are counted, exhaustion is visible, and the destination is validated
 * before it is ever saved.
 */
const { query } = require('./pool');

const SEVERITY_RANK = { info: 0, warning: 1, serious: 2 };

function mapFinding(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceId: row.source_id,
    providerKey: row.provider_key,
    sourceUrl: row.source_url,
    category: row.category,
    severity: row.severity,
    summary: row.summary,
    whatChanged: row.what_changed,
    whyItMatters: row.why_it_matters,
    quotedPassage: row.quoted_passage,
    detectedTopics: row.detected_topics || [],
    changedChars: row.changed_chars,
    suspendedProvider: row.suspended_provider,
    suspensionRule: row.suspension_rule,
    aiAssisted: row.ai_assisted,
    aiModel: row.ai_model,
    detectedAt: row.detected_at,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
  };
}

/**
 * File a finding.
 *
 * No deduplication key, unlike `operational_findings`. A terms change is an
 * EVENT with a date, not a condition that persists — "they changed the training
 * clause on 4 March" and "they changed it again on 11 September" are two things
 * a person needs to see, and collapsing them onto one row would hide the
 * second. Volume is bounded by the diff gate, which is the point of the gate.
 */
async function insertFinding(finding, client = null) {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `INSERT INTO ai_policy_findings
       (source_id, provider_key, source_url, category, severity, summary,
        what_changed, why_it_matters, quoted_passage, detected_topics, changed_chars,
        suspended_provider, suspension_rule, ai_assisted, ai_model)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      finding.sourceId ?? null,
      finding.providerKey ?? null,
      finding.sourceUrl,
      finding.category || 'other',
      finding.severity || 'info',
      finding.summary,
      finding.whatChanged ?? null,
      finding.whyItMatters ?? null,
      finding.quotedPassage ?? null,
      finding.detectedTopics || [],
      finding.changedChars ?? null,
      finding.suspendedProvider === true,
      finding.suspensionRule ?? null,
      finding.aiAssisted === true,
      finding.aiModel ?? null,
    ]
  );
  return mapFinding(res.rows[0]);
}

async function listFindings({ limit = 50, unacknowledgedOnly = false } = {}) {
  const res = await query(
    `SELECT * FROM ai_policy_findings
      WHERE ($1::boolean IS FALSE OR acknowledged_at IS NULL)
      ORDER BY detected_at DESC, id DESC
      LIMIT $2`,
    [unacknowledgedOnly === true, Math.min(200, Math.max(1, Number(limit) || 50))]
  );
  return res.rows.map(mapFinding);
}

async function acknowledgeFinding(id, acknowledgedBy) {
  const res = await query(
    `UPDATE ai_policy_findings
        SET acknowledged_at = NOW(), acknowledged_by = $2
      WHERE id = $1 AND acknowledged_at IS NULL
      RETURNING *`,
    [id, acknowledgedBy || 'admin']
  );
  return mapFinding(res.rows[0]);
}

/** Is this finding severe enough for the operator's chosen threshold? */
function meetsSeverityThreshold(severity, minSeverity) {
  return (SEVERITY_RANK[severity] ?? 0) >= (SEVERITY_RANK[minSeverity] ?? 1);
}

// ─── the alert outbox ────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 6;
/** Backoff in minutes, indexed by attempts already made. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 240, 720];
const LEASE_MINUTES = 5;

/** Idempotent: one alert per finding, ever. */
async function enqueueAlert({ findingId, chatId, body }, client = null) {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `INSERT INTO ai_policy_alert_outbox (finding_id, chat_id, body)
     VALUES ($1, $2, $3)
     ON CONFLICT (finding_id) DO NOTHING
     RETURNING *`,
    [findingId, String(chatId), body]
  );
  return res.rows[0] || null;
}

/**
 * Claim due alerts.
 *
 * `FOR UPDATE SKIP LOCKED` so two workers never take the same row, and
 * **attempts are incremented at CLAIM time, not at failure**: a send that
 * crashes the process mid-flight has still consumed an attempt, which is what
 * keeps a crash loop bounded instead of retrying forever.
 */
async function claimDueAlerts(limit = 5) {
  const res = await query(
    `WITH due AS (
       SELECT id FROM ai_policy_alert_outbox
        WHERE sent_at IS NULL
          AND attempts < $2
          AND next_attempt_at <= NOW()
          AND (locked_at IS NULL OR locked_at < NOW() - ($3 || ' minutes')::interval)
        ORDER BY next_attempt_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE ai_policy_alert_outbox o
        SET locked_at = NOW(), attempts = o.attempts + 1
       FROM due
      WHERE o.id = due.id
      RETURNING o.*`,
    [Math.max(1, limit), MAX_ATTEMPTS, String(LEASE_MINUTES)]
  );
  return res.rows;
}

async function markAlertSent(id) {
  await query(
    'UPDATE ai_policy_alert_outbox SET sent_at = NOW(), locked_at = NULL, last_error = NULL WHERE id = $1',
    [id]
  );
}

/** Backoff applied inside the failing UPDATE, so it cannot drift from attempts. */
async function markAlertFailed(id, error) {
  await query(
    `UPDATE ai_policy_alert_outbox
        SET locked_at = NULL,
            last_error = $2,
            next_attempt_at = NOW() + ((
              CASE WHEN attempts >= $3 THEN $4
                   ELSE ($5::int[])[attempts]
              END) || ' minutes')::interval
      WHERE id = $1`,
    [
      id,
      String(error || '').slice(0, 500),
      BACKOFF_MINUTES.length,
      BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1],
      BACKOFF_MINUTES,
    ]
  );
}

/**
 * Alerts that spent their whole budget and were never delivered.
 *
 * The counter that did not exist when 101 home-time alerts died silently. Read
 * by `/api/health` and by the admin, so a dead destination is something a human
 * learns about rather than something the database merely records.
 */
async function countExhaustedAlerts() {
  const res = await query(
    `SELECT COUNT(*)::int AS count, MIN(created_at) AS oldest_at
       FROM ai_policy_alert_outbox
      WHERE sent_at IS NULL AND attempts >= $1`,
    [MAX_ATTEMPTS]
  );
  return { count: res.rows[0].count, oldestAt: res.rows[0].oldest_at };
}

module.exports = {
  MAX_ATTEMPTS,
  BACKOFF_MINUTES,
  LEASE_MINUTES,
  SEVERITY_RANK,
  mapFinding,
  insertFinding,
  listFindings,
  acknowledgeFinding,
  meetsSeverityThreshold,
  enqueueAlert,
  claimDueAlerts,
  markAlertSent,
  markAlertFailed,
  countExhaustedAlerts,
};
