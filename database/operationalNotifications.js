/**
 * The operational-notice outbox — the one every new feature delivers through.
 *
 * This is the FOURTH copy of the durable-outbox shape in this repository and
 * deliberately the last: `homeTimeInternalAlertOutbox`, `homeTime/notices` and
 * `samsara_video_recovery_jobs` each earned theirs before there was a general
 * one. A fifth would mean a fifth place to look when a queue goes quiet, and
 * queues going quiet unnoticed is the failure that started all of this.
 *
 * The shape, unchanged because it is proven:
 *   - claim with FOR UPDATE SKIP LOCKED under a lease, so two processes cannot
 *     send the same notice;
 *   - increment `attempts` AT CLAIM TIME, so a worker that crashes mid-send
 *     still burns an attempt and a crash loop stays bounded;
 *   - apply the backoff inside the failing UPDATE, so the delay cannot drift
 *     from the attempt count;
 *   - reach a terminal `abandoned` state rather than retrying forever, and make
 *     that count visible.
 */
const { query, pool } = require('./pool');
const { recordDiscard, summariseDiscards } = require('./operationalNotificationDiscards');
const { summariseControlQuestions, summariseNotifications } = require('./operationalNotificationHealth');

const DEFAULT_LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 6;
/** 1 min → 5 → 15 → 1 h → 3 h, then give up. */
const BACKOFF_SECONDS = [60, 300, 900, 3600, 10800];

function backoffSecondsFor(attempts) {
  const idx = Math.max(0, Math.min(BACKOFF_SECONDS.length - 1, Number(attempts) - 1));
  return BACKOFF_SECONDS[idx];
}

function mapNotice(row) {
  if (!row) return null;
  return {
    id: row.id,
    noticeKey: row.notice_key,
    category: row.category,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    personId: row.person_id,
    groupId: row.group_id,
    chatId: row.chat_id,
    routedVia: row.routed_via,
    body: row.body,
    evidence: row.evidence_json || null,
    state: row.state,
    attempts: row.attempts,
    lastError: row.last_error,
    telegramMessageId: row.telegram_message_id,
    question: row.question_json || null,
    findingId: row.finding_id == null ? null : Number(row.finding_id),
    replyToMessageId: row.reply_to_message_id == null ? null : String(row.reply_to_message_id),
    answeredAt: row.answered_at || null,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

/**
 * Record a notice to be sent.
 *
 * @returns {Promise<object|null>} the row, or NULL when this exact notice is
 *   already known — which is the dedup guarantee, not an error. A caller that
 *   treats null as a failure will double-send the moment it retries.
 */
async function enqueueNotification({
  noticeKey, category, chatId, routedVia = 'default', body,
  subjectType = null, subjectId = null, personId = null, groupId = null, evidence = null,
  delaySeconds = 0, question = null, findingId = null, replyToMessageId = null,
}, client = null) {
  const run = client ? (t, v) => client.query(t, v) : query;
  // HELD, NOT DROPPED. `delaySeconds` pushes `next_attempt_at` out so the
  // sweep delivers this later instead of the caller sending it now. It is how
  // a burst about one driver stops being four interruptions without any of the
  // four being lost — see `shouldSuppress` in lib/notifications/priority.js.
  // Zero is the ordinary path and leaves the column at its NOW() default.
  const delay = Number.isFinite(Number(delaySeconds)) ? Math.max(0, Number(delaySeconds)) : 0;
  const res = await run(
    `INSERT INTO operational_notifications
       (notice_key, category, subject_type, subject_id, person_id, group_id,
        chat_id, routed_via, body, evidence_json, next_attempt_at,
        question_json, finding_id, reply_to_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb, NOW() + ($11 || ' seconds')::interval,
             $12::jsonb, $13, $14)
     ON CONFLICT (notice_key) DO NOTHING
     RETURNING *`,
    [
      noticeKey, category, subjectType, subjectId == null ? null : String(subjectId),
      personId, groupId, String(chatId), routedVia, body,
      evidence ? JSON.stringify(evidence) : null, String(delay),
      question ? JSON.stringify(question) : null,
      findingId == null ? null : Number(findingId),
      replyToMessageId == null ? null : String(replyToMessageId),
    ]
  );
  return mapNotice(res.rows[0]) || null;
}

/**
 * When we last said anything at all about this driver — across every category.
 *
 * THE QUESTION THE NOTICE KEY CANNOT ANSWER. That column stops the same notice
 * being sent twice and does its job perfectly; it has nothing to say about a
 * fuel risk, a load contradiction and a retention signal about ONE driver
 * arriving within minutes of each other, each correctly deduplicated against
 * itself, together reading as three problems rather than one bad morning.
 *
 * Reads the index `0031` created for exactly this and nothing had used:
 * `(person_id, created_at DESC) WHERE person_id IS NOT NULL`. The group and
 * subject forms fall back to the `(category, subject_type, subject_id, ...)`
 * index, which is why they are separate branches rather than one OR — an OR
 * across two partial indexes plans as a sequential scan.
 *
 * STATE IS DELIBERATELY NOT FILTERED. A notice enqueued four minutes ago and
 * not yet delivered is about to interrupt somebody just as surely as one that
 * already has.
 */
/**
 * SCOPED TO THE DESTINATION, because the flood is something a person SEES.
 *
 * Without the chat, three fuel notices delivered to the fuel team could hold
 * the first safety notice in a dedicated safety chat — nobody reading that chat
 * had seen the burst it was held for. The chat is already resolved by the time
 * this is asked, so scoping costs nothing. A null chat means "wherever it
 * went", which is right when an override has changed since.
 */
async function listRecentNoticesAbout({
  personId = null, groupId = null, subjectType = null, subjectId = null,
  chatId = null, withinMinutes = 60, limit = 20,
} = {}) {
  const minutes = String(Math.max(1, Number(withinMinutes) || 60));
  const cap = Math.max(1, Math.min(100, Number(limit) || 20));
  const chatClause = chatId ? 'AND chat_id = $CHAT' : '';
  const bind = (sql, n) => sql.replace('$CHAT', `$${n}`);
  let sql;
  let params;
  if (personId != null) {
    sql = bind(`SELECT created_at FROM operational_notifications
            WHERE person_id = $1 AND created_at > NOW() - ($2 || ' minutes')::interval
              ${chatClause}
            ORDER BY created_at DESC LIMIT $3`, 4);
    params = [personId, minutes, cap];
  } else if (groupId != null) {
    sql = bind(`SELECT created_at FROM operational_notifications
            WHERE group_id = $1 AND created_at > NOW() - ($2 || ' minutes')::interval
              ${chatClause}
            ORDER BY created_at DESC LIMIT $3`, 4);
    params = [groupId, minutes, cap];
  } else if (subjectType && subjectId != null) {
    sql = bind(`SELECT created_at FROM operational_notifications
            WHERE subject_type = $1 AND subject_id = $2
              AND created_at > NOW() - ($3 || ' minutes')::interval
              ${chatClause}
            ORDER BY created_at DESC LIMIT $4`, 5);
    params = [subjectType, String(subjectId), minutes, cap];
  } else {
    return [];
  }
  if (chatId) params.push(String(chatId));
  const res = await query(sql, params);
  return res.rows.map((r) => ({ at: r.created_at }));
}

/**
 * How many notices about this subject are already HELD for later.
 *
 * THE BURST THE HOLD MOVED RATHER THAN REMOVED. Every held row was dated
 * forward by the same fixed window, so a hundred notices became three now and
 * ninety-seven together an hour later. Each additional hold for the same
 * subject now waits one window longer than the last, which spreads them instead
 * of stacking them on one minute.
 */
async function countHeldNoticesAbout({
  personId = null, groupId = null, subjectType = null, subjectId = null, chatId = null,
} = {}) {
  const where = ['state = \'pending\'', 'next_attempt_at > NOW()'];
  const params = [];
  if (personId != null) { params.push(personId); where.push(`person_id = $${params.length}`); }
  else if (groupId != null) { params.push(groupId); where.push(`group_id = $${params.length}`); }
  else if (subjectType && subjectId != null) {
    params.push(subjectType); where.push(`subject_type = $${params.length}`);
    params.push(String(subjectId)); where.push(`subject_id = $${params.length}`);
  } else return 0;
  if (chatId) { params.push(String(chatId)); where.push(`chat_id = $${params.length}`); }
  const res = await query(
    `SELECT COUNT(*)::int AS n FROM operational_notifications WHERE ${where.join(' AND ')}`,
    params
  );
  return res.rows[0]?.n || 0;
}

/**
 * Has this notice been sent recently enough that saying it again would be noise?
 *
 * A condition that is still true a week later IS worth repeating, which is why
 * this is a window rather than the UNIQUE constraint alone. Callers that want
 * "once, ever" put an immutable discriminator in the key instead.
 */
/**
 * A PENDING ROW COUNTS, because it will still be said.
 *
 * This looked only at `delivered`, and the fuel watch's discriminator carries
 * the hour. So a notice HELD at 10:30 was invisible here, the key changed at
 * 11:00, a second copy of the same risk was enqueued, and both eventually
 * arrived inside a repeat window set to 6-48 hours — the hold created the
 * duplicate it exists to prevent.
 *
 * `abandoned` is excluded deliberately: it will never arrive, so it must not
 * suppress the notice that replaces it. A failed row is still `pending` and
 * still counts, because it is still being retried.
 */
async function noticeSentWithin(noticeKeyPrefix, hours) {
  const res = await query(
    `SELECT 1 FROM operational_notifications
      WHERE notice_key LIKE $1 || '%'
        -- A PENDING ROW WILL STILL BE SAID, so saying it again is repetition.
        -- See the note above this function. Abandoned is excluded on purpose.
        AND state IN ('delivered', 'pending')
        AND COALESCE(delivered_at, created_at) > NOW() - ($2 || ' hours')::interval
      LIMIT 1`,
    [noticeKeyPrefix, String(hours)]
  );
  return res.rowCount > 0;
}

/**
 * One notice by id, claimed under a lease. Used for an immediate send.
 *
 * The lease and the attempt limit are checked HERE, not only in the batch
 * claim. The sweep runs on its own timer and can reach a freshly inserted row
 * in the moment between the enqueue and this call; a claim that looked only at
 * `state = 'pending'` would succeed anyway, and both callers would send the
 * same notice — defeating the one guarantee this table exists to make.
 *
 * Returning null when somebody else holds the lease is the correct outcome, and
 * the caller treats it as a success: the sweep owns that notice now.
 */
async function claimNotificationById(id, { leaseSeconds = DEFAULT_LEASE_SECONDS } = {}) {
  const res = await query(
    `UPDATE operational_notifications
        SET claimed_until = NOW() + ($2 || ' seconds')::interval,
            attempts = attempts + 1,
            updated_at = NOW()
      WHERE id = $1
        AND state = 'pending'
        AND (claimed_until IS NULL OR claimed_until <= NOW())
        AND attempts < $3
      RETURNING *`,
    [id, String(leaseSeconds), MAX_ATTEMPTS]
  );
  return mapNotice(res.rows[0]) || null;
}

/**
 * Move rows that have burned every attempt to a terminal state.
 *
 * Without this they stay `pending` forever, invisible to the "is anything
 * stuck?" count and skipped by every claim because `attempts >= MAX`. That is
 * exactly how 101 undelivered alerts sat unnoticed for months.
 */
async function reapExhaustedNotifications() {
  const res = await query(
    `UPDATE operational_notifications
        SET state = 'abandoned', updated_at = NOW()
      WHERE state = 'pending' AND attempts >= $1
      RETURNING id`,
    [MAX_ATTEMPTS]
  );
  return res.rowCount;
}

/** Claim a batch of due notices. Reaps exhausted rows first. */
async function claimDueNotifications({ limit = 10, leaseSeconds = DEFAULT_LEASE_SECONDS } = {}) {
  await reapExhaustedNotifications().catch(() => {});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = await client.query(
      `SELECT id FROM operational_notifications
        WHERE state = 'pending'
          AND next_attempt_at <= NOW()
          AND (claimed_until IS NULL OR claimed_until <= NOW())
          AND attempts < $1
        ORDER BY next_attempt_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [MAX_ATTEMPTS, limit]
    );
    const ids = due.rows.map((r) => r.id);
    if (!ids.length) {
      await client.query('COMMIT');
      return [];
    }
    const claimed = await client.query(
      `UPDATE operational_notifications
          SET claimed_until = NOW() + ($2 || ' seconds')::interval,
              attempts = attempts + 1,
              updated_at = NOW()
        WHERE id = ANY($1::bigint[])
        RETURNING *`,
      [ids, String(leaseSeconds)]
    );
    await client.query('COMMIT');
    return claimed.rows.map(mapNotice);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function markNotificationDelivered(id, { telegramMessageId = null } = {}) {
  const res = await query(
    `UPDATE operational_notifications
        SET state = 'delivered', delivered_at = NOW(), claimed_until = NULL,
            last_error = NULL, telegram_message_id = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, telegramMessageId]
  );
  return mapNotice(res.rows[0]);
}

/**
 * Record a failure and schedule the next try.
 *
 * The delay is computed INSIDE the failing UPDATE, from the row's own attempt
 * count, so it cannot drift from it — reading the count in JS and writing the
 * delay back is two statements a concurrent claim can interleave with.
 *
 * `GREATEST(attempts, 1)` is load-bearing: PostgreSQL arrays are 1-based, so an
 * attempts of 0 indexes nothing, the ladder yields NULL, and NOW() + NULL
 * violates `next_attempt_at NOT NULL` — a failure on the very first attempt
 * would take the whole enqueue down with it.
 */
async function markNotificationFailed(id, error) {
  const res = await query(
    `UPDATE operational_notifications
        SET state = CASE WHEN attempts >= $3 THEN 'abandoned' ELSE 'pending' END,
            claimed_until = NULL,
            last_error = LEFT($2, 500),
            next_attempt_at = NOW() + (CASE
              WHEN attempts >= $3 THEN 0
              ELSE (ARRAY[60, 300, 900, 3600, 10800])[LEAST(GREATEST(attempts, 1), 5)]
            END || ' seconds')::interval,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, String(error || 'unknown error'), MAX_ATTEMPTS]
  );
  return mapNotice(res.rows[0]);
}

/** Release a claim without counting it as a failure (a clean shutdown). */
async function releaseNotificationClaim(id) {
  await query(
    'UPDATE operational_notifications SET claimed_until = NULL, updated_at = NOW() WHERE id = $1',
    [id]
  );
}

/**
 * The notice a Telegram reply is answering.
 *
 * `(chat_id, telegram_message_id)` is NOT unique and deliberately so: the same
 * message id recurs across chats, and a resend can legitimately produce a
 * second row carrying one. Newest wins, because that is the message the person
 * was looking at when they replied.
 *
 * Returns null for a message we never sent, which is the ordinary case — most
 * replies in a busy group are people talking to each other.
 */
async function findNoticeByTelegramMessage(chatId, telegramMessageId) {
  if (chatId == null || telegramMessageId == null) return null;
  const res = await query(
    `SELECT * FROM operational_notifications
      WHERE chat_id = $1 AND telegram_message_id = $2
      ORDER BY id DESC LIMIT 1`,
    [String(chatId), String(telegramMessageId)]
  );
  return mapNotice(res.rows[0]);
}

/**
 * Close a question.
 *
 * ONLY THE FIRST ANSWER COUNTS — `answered_at IS NULL` is in the WHERE clause,
 * not checked by the caller beforehand. Two operators replying to the same
 * question within a second of each other is exactly the race that would
 * otherwise apply one correction twice, and the caller cannot close it from
 * outside the statement.
 *
 * @returns {Promise<boolean>} true when THIS reply is the one that closed it.
 */
async function markNoticeAnswered(id, replyId, client = null) {
  const run = client ? (t, v) => client.query(t, v) : query;
  const res = await run(
    `UPDATE operational_notifications
        SET answered_at = NOW(), answered_by_reply_id = $2, updated_at = NOW()
      WHERE id = $1 AND answered_at IS NULL
      RETURNING id`,
    [id, replyId == null ? null : Number(replyId)]
  );
  return res.rowCount > 0;
}

/**
 * How many questions are out there that nobody has answered.
 *
 * THE GUARD AGAINST A FLOOD ON THE FIRST DAY. A per-pass cap only limits one
 * pass; the sweep runs every fifteen minutes, so five questions a pass is four
 * hundred and eighty a day if nothing else stops it — and a hundred unanswered
 * questions is not a control channel, it is the old silence with a notification
 * sound. The ask pass stands down while this number is at its limit, so the
 * queue drains at the speed the owner actually answers.
 *
 * Scoped to a window, because a question from three weeks ago that nobody will
 * ever answer must not silence the channel for ever.
 */
async function countUnansweredQuestions(withinHours = 72) {
  try {
    const res = await query(
      `SELECT COUNT(*)::int AS n
         FROM operational_notifications
        WHERE question_json IS NOT NULL
          AND answered_at IS NULL
          AND state IN ('pending', 'delivered')
          AND created_at > NOW() - ($1 || ' hours')::interval`,
      [String(Math.max(1, Number(withinHours) || 72))]
    );
    return res.rows[0]?.n || 0;
  } catch (_) {
    // A read that failed must not become permission to ask more.
    return Number.MAX_SAFE_INTEGER;
  }
}

module.exports = {
  recordDiscard,
  summariseDiscards,
  MAX_ATTEMPTS,
  BACKOFF_SECONDS,
  backoffSecondsFor,
  enqueueNotification,
  listRecentNoticesAbout,
  countHeldNoticesAbout,
  noticeSentWithin,
  claimNotificationById,
  claimDueNotifications,
  reapExhaustedNotifications,
  markNotificationDelivered,
  markNotificationFailed,
  releaseNotificationClaim,
  findNoticeByTelegramMessage,
  markNoticeAnswered,
  countUnansweredQuestions,
  summariseControlQuestions,
  summariseNotifications,
};
