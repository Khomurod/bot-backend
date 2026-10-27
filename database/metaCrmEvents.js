'use strict';

/**
 * Bitrix stage → Meta CRM events: the ledger that makes each one reach Meta
 * ONCE. Migration 0085.
 *
 *   recordEvents  INSERT … ON CONFLICT (leadgen_id, event_name) DO NOTHING —
 *                 only rows actually inserted come back. A lead whose deal
 *                 moves Interested → Documents → Sent to Safety is one
 *                 "Qualified", not three;
 *   markSent      WHERE state = 'pending' — a sent row never becomes pending
 *                 again, so nothing turns a success into a retry;
 *   markFailed    counts the attempt; the MAX_ATTEMPTS-th, or a row whose
 *                 event_time has left Meta's seven-day window, is `gave_up`.
 *
 * Only the stage-sync pass writes here, from one process behind its own
 * `tickRunning` guard, so a pending row needs no lease.
 */
const { query } = require('./pool');

const MAX_ATTEMPTS = 5;
const MAX_AGE_SQL = "INTERVAL '7 days'";

/** leads.bitrix_id → leads.external_id (the leadgen id), for Facebook leads only. */
async function findLeadgenIdsByBitrixIds(bitrixIds) {
  const ids = [...new Set((bitrixIds || []).map((v) => String(v)).filter(Boolean))];
  if (!ids.length) return new Map();
  const res = await query(
    `SELECT bitrix_id, external_id FROM leads
      WHERE source = 'facebook' AND bitrix_id = ANY($1::text[]) AND external_id IS NOT NULL`,
    [ids]
  );
  return new Map(res.rows.map((r) => [String(r.bitrix_id), String(r.external_id)]));
}

/**
 * Which of these (leadgen id, event) pairs the ledger already holds, as
 * `leadgenId|eventName` keys. READ ONLY — the settings dry run uses it to say
 * what a pass WOULD send without recording anything.
 */
async function findRecordedKeys(plan) {
  if (!plan?.length) return new Set();
  const res = await query(
    `SELECT leadgen_id, event_name FROM meta_crm_events
      WHERE (leadgen_id, event_name) IN (SELECT * FROM UNNEST($1::text[], $2::text[]))`,
    [plan.map((p) => p.leadgenId), plan.map((p) => p.eventName)]
  );
  return new Set(res.rows.map((r) => `${r.leadgen_id}|${r.event_name}`));
}

/**
 * The newest Facebook leadgen id on record, or null. The settings Test sends
 * its one TEST event about a real lead, so Meta has something to match.
 */
async function latestLeadgenId() {
  const res = await query(
    `SELECT external_id FROM leads
      WHERE source = 'facebook' AND external_id ~ '^[0-9]{6,25}$'
      ORDER BY id DESC LIMIT 1`
  );
  return res.rows[0]?.external_id || null;
}

/** Record planned events. Returns only the rows this call inserted. */
async function recordEvents(plan) {
  if (!plan?.length) return [];
  const res = await query(
    `INSERT INTO meta_crm_events (leadgen_id, event_name, deal_id, stage_id, event_time)
     SELECT * FROM UNNEST($1::text[], $2::text[], $3::bigint[], $4::text[], $5::timestamptz[])
     ON CONFLICT (leadgen_id, event_name) DO NOTHING
     RETURNING id`,
    [
      plan.map((p) => p.leadgenId),
      plan.map((p) => p.eventName),
      plan.map((p) => p.dealId),
      plan.map((p) => p.stageId),
      plan.map((p) => p.eventTime),
    ]
  );
  return res.rows.map((r) => r.id);
}

/**
 * Pending rows still inside Meta's window, oldest first. A pending row that
 * has aged out is closed as `gave_up` here first — Meta would refuse it, and
 * retrying it forever would be the abandoned-lead-at-9,041-attempts mistake
 * again.
 */
async function listDue(limit = 200) {
  await query(
    `UPDATE meta_crm_events SET state = 'gave_up', last_error = COALESCE(last_error, 'older than seven days')
      WHERE state = 'pending' AND event_time < NOW() - ${MAX_AGE_SQL}`
  );
  const res = await query(
    `SELECT id, leadgen_id, event_name, deal_id::text AS deal_id, stage_id, event_time, attempts
       FROM meta_crm_events
      WHERE state = 'pending'
      ORDER BY event_time ASC, id ASC
      LIMIT $1`,
    [Math.max(1, Number(limit) || 200)]
  );
  return res.rows;
}

async function markSent(id) {
  const res = await query(
    `UPDATE meta_crm_events SET state = 'sent', sent_at = NOW(), attempts = attempts + 1, last_error = NULL
      WHERE id = $1 AND state = 'pending'`,
    [id]
  );
  return res.rowCount === 1;
}

/** Count a failed attempt. Returns the row's new state. */
async function markFailed(id, error) {
  const res = await query(
    `UPDATE meta_crm_events
        SET attempts = attempts + 1,
            last_error = LEFT($2, 300),
            state = CASE WHEN attempts + 1 >= $3 THEN 'gave_up' ELSE 'pending' END
      WHERE id = $1 AND state = 'pending'
      RETURNING state`,
    [id, String(error || 'unknown error'), MAX_ATTEMPTS]
  );
  return res.rows[0]?.state || null;
}

module.exports = {
  MAX_ATTEMPTS,
  findLeadgenIdsByBitrixIds,
  findRecordedKeys,
  latestLeadgenId,
  recordEvents,
  listDue,
  markSent,
  markFailed,
};
