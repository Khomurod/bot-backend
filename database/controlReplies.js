/**
 * Every reply to an operational question — obeyed, refused, or ignored.
 *
 * TWO JOBS, AND THE FIRST ONE IS THE IMPORTANT ONE.
 *
 * 1. THE REDELIVERY GUARD. Telegram can deliver the same update twice, and
 *    the bot restarts several times a day. Without a uniqueness guard a
 *    redelivered "yes" applies the same correction a second time — to the
 *    fleet, silently. `recordReply` claims `(chat_id, reply_message_id)` and
 *    returns NULL when the claim loses. A null return is not an error: it is
 *    "somebody else already has this reply", and the caller must stop.
 *    The claim happens BEFORE anything is acted on, for the same reason the
 *    outbox counts an attempt at claim time.
 *
 * 2. The trail. A reply from somebody who is not an operator is recorded too —
 *    "a stranger answered an operational question" is exactly the sort of
 *    thing that should leave a trace rather than being silently dropped.
 */
const { query } = require('./pool');

const MAX_TEXT = 1000;

function mapReply(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    notificationId: row.notification_id == null ? null : Number(row.notification_id),
    chatId: String(row.chat_id),
    replyMessageId: String(row.reply_message_id),
    repliedToMessageId: row.replied_to_message_id == null ? null : String(row.replied_to_message_id),
    telegramUserId: row.telegram_user_id == null ? null : String(row.telegram_user_id),
    authorised: row.authorised === true,
    rawText: row.raw_text || null,
    intent: row.intent_json || null,
    chosenAction: row.chosen_action || null,
    outcome: row.outcome,
    findingId: row.finding_id == null ? null : Number(row.finding_id),
    decisionId: row.decision_id == null ? null : Number(row.decision_id),
    correctionId: row.correction_id == null ? null : Number(row.correction_id),
    createdAt: row.created_at,
  };
}

/**
 * Claim a reply.
 *
 * @returns {Promise<object|null>} the row, or NULL when this reply is already
 *   recorded — a redelivery. STOP on null; do not act.
 */
async function recordReply({
  notificationId = null, chatId, replyMessageId, repliedToMessageId = null,
  telegramUserId = null, authorised = false, rawText = null, outcome,
  intent = null, chosenAction = null, findingId = null,
}) {
  // Truncated rather than refused: a reply too long to store is still a reply
  // somebody made, and losing the record of it is worse than losing its tail.
  const text = rawText == null ? null : String(rawText).slice(0, MAX_TEXT);
  const res = await query(
    `INSERT INTO control_replies
       (notification_id, chat_id, reply_message_id, replied_to_message_id,
        telegram_user_id, authorised, raw_text, intent_json, chosen_action,
        outcome, finding_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
     ON CONFLICT (chat_id, reply_message_id) DO NOTHING
     RETURNING *`,
    [
      notificationId == null ? null : Number(notificationId),
      String(chatId), String(replyMessageId),
      repliedToMessageId == null ? null : String(repliedToMessageId),
      telegramUserId == null ? null : String(telegramUserId),
      authorised === true, text,
      intent ? JSON.stringify(intent) : null,
      chosenAction, String(outcome),
      findingId == null ? null : Number(findingId),
    ]
  );
  return mapReply(res.rows[0]);
}

/**
 * Record what the reply turned out to mean and what it did.
 *
 * Separate from `recordReply` because the claim must land before the work
 * starts and the outcome is only known after.
 */
async function finaliseReply(id, {
  outcome, intent = null, chosenAction = null,
  findingId = null, decisionId = null, correctionId = null,
}) {
  const res = await query(
    `UPDATE control_replies
        SET outcome = $2,
            intent_json = COALESCE($3::jsonb, intent_json),
            chosen_action = COALESCE($4, chosen_action),
            finding_id = COALESCE($5, finding_id),
            decision_id = COALESCE($6, decision_id),
            correction_id = COALESCE($7, correction_id)
      WHERE id = $1
      RETURNING *`,
    [
      Number(id), String(outcome),
      intent ? JSON.stringify(intent) : null,
      chosenAction,
      findingId == null ? null : Number(findingId),
      decisionId == null ? null : Number(decisionId),
      correctionId == null ? null : Number(correctionId),
    ]
  );
  return mapReply(res.rows[0]);
}

/** Every reply about one finding, oldest first — what the admin shows. */
async function listRepliesForFinding(findingId, { limit = 20 } = {}) {
  try {
    const res = await query(
      `SELECT * FROM control_replies WHERE finding_id = $1
        ORDER BY created_at ASC LIMIT $2`,
      [Number(findingId), Math.max(1, Math.min(100, Number(limit) || 20))]
    );
    return res.rows.map(mapReply);
  } catch (_) {
    return [];
  }
}

/** Counts only, for /api/health. No text ever leaves this function. */
async function summariseControlReplies() {
  try {
    const res = await query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE authorised = FALSE)::int AS refused,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS last7d,
              MAX(created_at) AS last_at
         FROM control_replies`
    );
    const r = res.rows[0] || {};
    return {
      available: true,
      total: r.total || 0,
      refused: r.refused || 0,
      last7d: r.last7d || 0,
      lastAt: r.last_at || null,
    };
  } catch (_) {
    return { available: false, total: 0, refused: 0, last7d: 0, lastAt: null };
  }
}

module.exports = {
  MAX_TEXT,
  recordReply,
  finaliseReply,
  listRepliesForFinding,
  summariseControlReplies,
};
