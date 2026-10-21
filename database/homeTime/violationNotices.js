'use strict';

/**
 * Home-time violation alerts — the rows that make each one arrive ONCE, and
 * accounting's answer to it. Migration 0079.
 *
 * Every write that matters is conditional, so the guarantees hold under any
 * interleaving of the webhook, the reconciliation pass and a restart:
 *
 *   recordViolations   INSERT … ON CONFLICT (deal, home stay, violation) DO
 *                      NOTHING — only the rows actually inserted come back,
 *                      and only those may be posted;
 *   claimForPosting    a lease, so two posters never send the same rows;
 *   decide             WHERE decision IS NULL — a second tap or a second
 *                      accountant changes nothing;
 *   recordReason       only the person who pressed "Not charging", once.
 */
const { query } = require('../pool');

const MAX_ATTEMPTS = 6;
const LEASE_SECONDS = 120;

/**
 * The columns every reader gets. `home_from` comes back as TEXT: node-postgres
 * turns a DATE into a JavaScript Date at LOCAL midnight, and a calendar date
 * that moves with the server's timezone is half of an idempotency key.
 */
const COLUMNS = `id, deal_id::text AS deal_id, home_from::text AS home_from, violation, stage_id,
  driver_name, road_days, home_days, state, chat_id, telegram_message_id, attempts, last_error,
  decision, decided_by_id, decided_by_name, decided_at, decision_reason, reason_prompt_message_id`;

async function getViolationSettings() {
  const res = await query(
    `SELECT violation_alerts_enabled, violation_alerts_chat_id, violation_alerts_baselined_at
       FROM home_time_settings WHERE id = 1`
  );
  return res.rows[0] || null;
}

/** The first pass after switching on records the existing cards, then says so here. */
async function markBaselined() {
  const res = await query(
    `UPDATE home_time_settings SET violation_alerts_baselined_at = NOW()
      WHERE id = 1 AND violation_alerts_baselined_at IS NULL
      RETURNING violation_alerts_baselined_at`
  );
  return res.rows[0]?.violation_alerts_baselined_at || null;
}

/** Violations already recorded for this home stay, in any state. */
async function listRecordedViolations(dealId, homeFrom) {
  const res = await query(
    'SELECT violation FROM home_time_violation_notices WHERE deal_id = $1 AND home_from = $2',
    [Number(dealId), homeFrom]
  );
  return res.rows.map((r) => r.violation);
}

/**
 * Record a card's violations. Returns ONLY the rows this call inserted — a
 * violation somebody else recorded first comes back as nothing.
 */
async function recordViolations({ deal, violations, state = 'pending' }) {
  if (!violations?.length) return [];
  const res = await query(
    `INSERT INTO home_time_violation_notices
       (deal_id, home_from, violation, stage_id, driver_name, road_days, home_days, state)
     SELECT $1, $2::date, v, $4, $5, $6, $7, $8
       FROM unnest($3::text[]) AS v
     ON CONFLICT ON CONSTRAINT home_time_violation_notices_once DO NOTHING
     RETURNING ${COLUMNS}`,
    [deal.dealId, deal.homeFrom, violations, deal.stageId, deal.driverName,
      deal.roadDays, deal.homeDays, state]
  );
  return res.rows;
}

/** Take the lease on these rows for one send. Rows another poster holds are left out. */
async function claimForPosting(ids) {
  if (!ids?.length) return [];
  const res = await query(
    `UPDATE home_time_violation_notices
        SET claimed_until = NOW() + make_interval(secs => $2), attempts = attempts + 1
      WHERE id = ANY($1::bigint[])
        AND state IN ('pending', 'failed')
        AND (claimed_until IS NULL OR claimed_until < NOW())
      RETURNING ${COLUMNS}`,
    [ids.map(Number), LEASE_SECONDS]
  );
  return res.rows;
}

async function markPosted(ids, { chatId, messageId }) {
  await query(
    `UPDATE home_time_violation_notices
        SET state = 'posted', chat_id = $2, telegram_message_id = $3, posted_at = NOW(),
            claimed_until = NULL, last_error = NULL
      WHERE id = ANY($1::bigint[])`,
    [ids.map(Number), String(chatId), Number(messageId)]
  );
}

/** A failed send waits for the next pass; the sixth gives up and says so. */
async function markFailed(ids, error) {
  await query(
    `UPDATE home_time_violation_notices
        SET state = CASE WHEN attempts >= $3 THEN 'abandoned' ELSE 'failed' END,
            claimed_until = NULL, last_error = $2
      WHERE id = ANY($1::bigint[])`,
    [ids.map(Number), String(error || 'send failed').slice(0, 500), MAX_ATTEMPTS]
  );
}

/** Rows a failed or interrupted send left behind, oldest first. */
async function listDue(limit = 50) {
  const res = await query(
    `SELECT ${COLUMNS} FROM home_time_violation_notices
      WHERE state IN ('pending', 'failed')
        AND (claimed_until IS NULL OR claimed_until < NOW())
      ORDER BY id
      LIMIT $1`,
    [limit]
  );
  return res.rows;
}

async function countAbandoned() {
  const res = await query("SELECT COUNT(*)::int AS n FROM home_time_violation_notices WHERE state = 'abandoned'");
  return res.rows[0]?.n || 0;
}

async function getNotice(id) {
  const res = await query(`SELECT ${COLUMNS} FROM home_time_violation_notices WHERE id = $1`, [Number(id)]);
  return res.rows[0] || null;
}

/** Every row one message carries. */
async function listByMessage(chatId, messageId) {
  const res = await query(
    `SELECT ${COLUMNS} FROM home_time_violation_notices
      WHERE chat_id = $1 AND telegram_message_id = $2 ORDER BY id`,
    [String(chatId), Number(messageId)]
  );
  return res.rows;
}

/**
 * Accounting's answer, written once for every row the message carries.
 * `{ rows, alreadyDecided }` — rows come back either way, so the caller can say
 * who decided first.
 */
async function decide({
  chatId, messageId, decision, byId, byName,
}) {
  const res = await query(
    `UPDATE home_time_violation_notices
        SET decision = $3, decided_by_id = $4, decided_by_name = $5, decided_at = NOW()
      WHERE chat_id = $1 AND telegram_message_id = $2 AND decision IS NULL
      RETURNING ${COLUMNS}`,
    [String(chatId), Number(messageId), decision, String(byId), byName || null]
  );
  if (res.rows.length) return { rows: res.rows, alreadyDecided: false };
  return { rows: await listByMessage(chatId, messageId), alreadyDecided: true };
}

async function setReasonPrompt({ chatId, messageId, promptMessageId }) {
  await query(
    `UPDATE home_time_violation_notices SET reason_prompt_message_id = $3
      WHERE chat_id = $1 AND telegram_message_id = $2 AND decision = 'not_charging'`,
    [String(chatId), Number(messageId), Number(promptMessageId)]
  );
}

/**
 * The reason, from the person who pressed "Not charging", replying to the
 * prompt. Written once. Returns the rows it wrote, or [] when this reply is
 * not that answer.
 */
async function recordReason({
  chatId, promptMessageId, byId, reason,
}) {
  const res = await query(
    `UPDATE home_time_violation_notices SET decision_reason = $4
      WHERE chat_id = $1 AND reason_prompt_message_id = $2 AND decided_by_id = $3
        AND decision = 'not_charging' AND decision_reason IS NULL
      RETURNING ${COLUMNS}`,
    [String(chatId), Number(promptMessageId), String(byId), String(reason).slice(0, 500)]
  );
  return res.rows;
}

module.exports = {
  MAX_ATTEMPTS,
  LEASE_SECONDS,
  getViolationSettings,
  markBaselined,
  listRecordedViolations,
  recordViolations,
  claimForPosting,
  markPosted,
  markFailed,
  listDue,
  countAbandoned,
  getNotice,
  listByMessage,
  decide,
  setReasonPrompt,
  recordReason,
};
