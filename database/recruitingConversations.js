'use strict';

/**
 * How far Wenze has gone on its own in one candidate's conversation.
 *
 * Keyed on the phone number, because that is the only identifier both sides of
 * an SMS share. A lead can exist twice in Bitrix and a Telegram thread can be
 * recreated; the number is the conversation.
 *
 * EVERY COUNTER IS INCREMENTED IN SQL, never read-then-written in JavaScript.
 * Two inbound texts arriving together is the ordinary case for a candidate
 * answering in fragments, and a reply cap enforced by a read-modify-write can
 * be walked straight past by the second one.
 */
const { query } = require('./pool');

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    driverPhone: row.driver_phone,
    leadName: row.lead_name,
    recruiterId: row.recruiter_id,
    telegramChatId: row.telegram_chat_id,
    status: row.status,
    stopReason: row.stop_reason,
    repliesSent: Number(row.replies_sent || 0),
    refusals: Number(row.refusals || 0),
    lastReplyAt: row.last_reply_at,
    lastRefusalReason: row.last_refusal_reason,
    acknowledgedAt: row.acknowledged_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The row for this candidate, creating it if this is the first time.
 *
 * `lead_name`, `recruiter_id` and `telegram_chat_id` are filled in on conflict
 * only when the existing row has none: the first sighting of a recruiter is the
 * one that owns the conversation, and a later inbound SMS that happens to reach
 * a different number must not silently move it.
 */
async function ensureConversation({
  driverPhone, leadName = null, recruiterId = null, telegramChatId = null,
}) {
  const phone = String(driverPhone || '').trim();
  if (!phone) return null;
  const res = await query(
    `INSERT INTO recruiting_ai_conversations
       (driver_phone, lead_name, recruiter_id, telegram_chat_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (driver_phone) DO UPDATE
       SET lead_name = COALESCE(recruiting_ai_conversations.lead_name, EXCLUDED.lead_name),
           recruiter_id = COALESCE(recruiting_ai_conversations.recruiter_id, EXCLUDED.recruiter_id),
           telegram_chat_id = COALESCE(recruiting_ai_conversations.telegram_chat_id, EXCLUDED.telegram_chat_id),
           updated_at = NOW()
     RETURNING *`,
    [phone, leadName, recruiterId, telegramChatId]
  );
  return mapRow(res.rows[0]);
}

async function getConversation(driverPhone) {
  const phone = String(driverPhone || '').trim();
  if (!phone) return null;
  const res = await query(
    'SELECT * FROM recruiting_ai_conversations WHERE driver_phone = $1',
    [phone]
  );
  return mapRow(res.rows[0]);
}

/** One more answer sent in the recruiter's name. */
async function recordReply(driverPhone, { at = null } = {}) {
  const res = await query(
    `UPDATE recruiting_ai_conversations
        SET replies_sent = replies_sent + 1,
            last_reply_at = COALESCE($2::timestamptz, NOW()),
            updated_at = NOW()
      WHERE driver_phone = $1
      RETURNING *`,
    [String(driverPhone || '').trim(), at]
  );
  return mapRow(res.rows[0]);
}

/**
 * A reply the guard refused.
 *
 * Counted separately from replies because the two mean opposite things about
 * the feature: replies sent is how much work it saved, refusals is how often a
 * model tried to say something it must not. A rising refusal count on one
 * conversation is the signal that the knowledge base is missing an answer.
 */
async function recordRefusal(driverPhone, reason) {
  const res = await query(
    `UPDATE recruiting_ai_conversations
        SET refusals = refusals + 1,
            last_refusal_reason = $2,
            updated_at = NOW()
      WHERE driver_phone = $1
      RETURNING *`,
    [String(driverPhone || '').trim(), String(reason || '').slice(0, 200) || null]
  );
  return mapRow(res.rows[0]);
}

async function markAcknowledged(driverPhone) {
  const res = await query(
    `UPDATE recruiting_ai_conversations
        SET acknowledged_at = COALESCE(acknowledged_at, NOW()), updated_at = NOW()
      WHERE driver_phone = $1
      RETURNING *`,
    [String(driverPhone || '').trim()]
  );
  return mapRow(res.rows[0]);
}

/**
 * Stand down on this conversation.
 *
 * `handed_off` when a person took it back, `stopped` when a guard will keep
 * refusing. Both are reversible from the admin, and neither deletes anything —
 * the counters stay, because "Wenze answered four times and then a recruiter
 * took over" is the sentence somebody will want six weeks from now.
 */
async function closeConversation(driverPhone, { status = 'handed_off', reason = null } = {}) {
  const allowed = new Set(['active', 'handed_off', 'stopped']);
  const next = allowed.has(status) ? status : 'handed_off';
  const res = await query(
    `UPDATE recruiting_ai_conversations
        SET status = $2, stop_reason = $3, updated_at = NOW()
      WHERE driver_phone = $1
      RETURNING *`,
    [String(driverPhone || '').trim(), next, reason ? String(reason).slice(0, 200) : null]
  );
  return mapRow(res.rows[0]);
}

/** The admin list: what Wenze has been carrying, newest activity first. */
async function listConversations({ limit = 50, status = null } = {}) {
  const clauses = [];
  const values = [];
  if (status) { values.push(status); clauses.push(`status = $${values.length}`); }
  values.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  const res = await query(
    `SELECT * FROM recruiting_ai_conversations
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY updated_at DESC
      LIMIT $${values.length}`,
    values
  );
  return res.rows.map(mapRow);
}

module.exports = {
  mapRow,
  ensureConversation,
  getConversation,
  recordReply,
  recordRefusal,
  markAcknowledged,
  closeConversation,
  listConversations,
};
