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

async function getPendingScheduledMessages() {
  const res = await query(
    `SELECT * FROM scheduled_messages
     WHERE status = 'pending' AND scheduled_at <= NOW()
     ORDER BY scheduled_at ASC`
  );
  return res.rows;
}

async function getAllScheduledMessages() {
  const res = await query(
    `SELECT * FROM scheduled_messages ORDER BY created_at DESC`
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
  deleteScheduledMessage,
};
