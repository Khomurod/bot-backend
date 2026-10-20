/**
 * Scheduled messages (one-time + weekly).
 * Extracted verbatim from database/db.js; db.js re-exports these.
 */
const { query } = require('./pool');

async function createScheduledMessage(data) {
  const mediaItems = Array.isArray(data.media_items) && data.media_items.length > 0
    ? data.media_items
    : null;
  const firstMedia = mediaItems && mediaItems.length > 0
    ? mediaItems[0]
    : null;
  const res = await query(
    `INSERT INTO scheduled_messages
      (message_text_en, message_text_ru, message_text_uz,
       media_items, media_file_id, media_type, media_position,
       target_type, target_driver_ids, target_languages,
       force_language, scheduled_at, schedule_type, schedule_timezone,
       weekly_day_of_week, weekly_time_local, target_active_filter, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'pending')
     RETURNING *`,
    [
      data.message_text_en, data.message_text_ru || null, data.message_text_uz || null,
      mediaItems ? JSON.stringify(mediaItems) : null,
      data.media_file_id || firstMedia?.file_id || null,
      data.media_type || firstMedia?.media_type || null,
      data.media_position || 'above',
      data.target_type || 'all',
      data.target_driver_ids || null,
      data.target_languages || null,
      data.force_language || null,
      data.scheduled_at,
      data.schedule_type || 'one_time',
      data.schedule_timezone || 'America/Chicago',
      data.weekly_day_of_week || null,
      data.weekly_time_local || null,
      data.target_active_filter || null,
    ]
  );
  console.log(`[DB] Scheduled message created: id=${res.rows[0].id}, at=${data.scheduled_at}`);
  return res.rows[0];
}

/**
 * The ids of the messages due now, oldest first — ids ONLY. The scheduler asks
 * every minute and nearly always gets nothing; `SELECT *` still described all
 * twenty-two columns each time. The full row comes from `claimScheduledMessage`,
 * the one step that needs it.
 */
async function getPendingScheduledMessages() {
  const res = await query(
    `SELECT id FROM scheduled_messages
     WHERE status = 'pending' AND scheduled_at <= NOW()
     ORDER BY scheduled_at ASC`
  );
  return res.rows;
}

/**
 * The admin queue view: every message still in play, plus a bounded slice of
 * finished history.
 *
 * The unbounded version returned EVERY row ever created — each carrying three
 * full message texts and a media_items JSONB blob — and the Scheduled Messages
 * page re-read it on a timer, so the same finished history crossed the database
 * link again and again for as long as a tab stayed open. Live rows
 * ('pending' and 'processing') are never dropped, because an admin must always
 * see what is still going to send; only the finished tail is capped.
 */
async function getAllScheduledMessages({ historyLimit = 100 } = {}) {
  const res = await query(
    `SELECT * FROM scheduled_messages WHERE status IN ('pending', 'processing')
     UNION ALL
     SELECT * FROM (
       SELECT * FROM scheduled_messages
       WHERE status NOT IN ('pending', 'processing')
       ORDER BY created_at DESC
       LIMIT $1
     ) recent_history
     ORDER BY created_at DESC`,
    [Math.max(1, Number(historyLimit) || 100)]
  );
  return res.rows;
}

async function getScheduledMessageById(id) {
  const res = await query('SELECT * FROM scheduled_messages WHERE id = $1', [id]);
  return res.rows[0];
}

async function updateScheduledMessageStatus(id, status) {
  const res = await query(
    'UPDATE scheduled_messages SET status = $1 WHERE id = $2 RETURNING *',
    [status, id]
  );
  return res.rows[0];
}

async function recordRecurringScheduledMessageRun(id, nextScheduledAt, lastRunStatus, markSent = false) {
  const res = await query(
    `UPDATE scheduled_messages
     SET status = 'pending',
         scheduled_at = $2,
         last_run_status = $3,
         last_sent_at = CASE WHEN $4 THEN NOW() ELSE last_sent_at END
     WHERE id = $1
     RETURNING *`,
    [id, nextScheduledAt, lastRunStatus, markSent]
  );
  return res.rows[0];
}

async function claimScheduledMessage(id) {
  const res = await query(
    `UPDATE scheduled_messages
     SET status = 'processing'
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id]
  );
  return res.rows[0] || null;
}

/**
 * Rows claimed for sending more than `olderThanMinutes` past their time and
 * never released — see `decideStaleClaim` in services/scheduledMessageUtils.js.
 * The age is computed here, in the database's own clock, because
 * `scheduled_at` is a TIMESTAMP without a zone and reading it back into
 * JavaScript would apply the process's.
 */
async function listStaleClaims({ olderThanMinutes = 120 } = {}) {
  const res = await query(
    `SELECT id, schedule_type, schedule_timezone, weekly_day_of_week, weekly_time_local,
            EXTRACT(EPOCH FROM (NOW() - scheduled_at)) / 86400.0 AS days_overdue
       FROM scheduled_messages
      WHERE status = 'processing'
        AND scheduled_at < NOW() - ($1 || ' minutes')::interval
      ORDER BY id`,
    [String(Math.max(1, Number(olderThanMinutes) || 120))]
  );
  return res.rows.map((r) => ({ ...r, days_overdue: Number(r.days_overdue) }));
}

/**
 * Release one stuck claim: back to `pending` at `nextScheduledAt`, or `failed`
 * when there is none. GUARDED ON `processing`, so a send that finishes after
 * all and writes its own outcome is never overwritten by this.
 * @returns {Promise<boolean>} whether the row was released
 */
async function releaseStaleClaim(id, { nextScheduledAt = null } = {}) {
  const res = nextScheduledAt
    ? await query(
      `UPDATE scheduled_messages
          SET status = 'pending', scheduled_at = $2, last_run_status = 'interrupted'
        WHERE id = $1 AND status = 'processing'`,
      [id, nextScheduledAt]
    )
    : await query(
      `UPDATE scheduled_messages
          SET status = 'failed', last_run_status = 'interrupted'
        WHERE id = $1 AND status = 'processing'`,
      [id]
    );
  return (res.rowCount || 0) > 0;
}

async function deleteScheduledMessage(id) {
  await query('DELETE FROM scheduled_messages WHERE id = $1', [id]);
}


module.exports = {
  createScheduledMessage,
  getPendingScheduledMessages,
  getAllScheduledMessages,
  getScheduledMessageById,
  updateScheduledMessageStatus,
  recordRecurringScheduledMessageRun,
  claimScheduledMessage,
  listStaleClaims,
  releaseStaleClaim,
  deleteScheduledMessage,
};
