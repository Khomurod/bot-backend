'use strict';

/**
 * `truck_photo_reports` — one row per `outbound` / `inbound` message: the
 * claim, then what became of it. The PDF itself is never stored; this row is
 * the record that it was sent (or why it was not).
 *
 * CLAIM BEFORE ACTING. Telegram redelivers an update it thinks was not
 * handled, and Telegraf handles a batch of updates at once, so the same word
 * can arrive twice. The UNIQUE (chat_id, trigger_message_id) constraint makes
 * the claim the one place that decides: the second INSERT returns nothing, and
 * nothing is done for it.
 *
 * A FINISH WRITES ONLY A PENDING ROW. The hourly sweep finishes a claim a
 * restarted process left behind; a late finish from that process (it cannot
 * happen inside the pass's deadline, but a clock is not a lock) must not turn
 * "interrupted" into "sent" or back.
 */

const { query } = require('../pool');

const STATUSES = Object.freeze(['pending', 'sent', 'failed', 'no_photos', 'not_a_handover', 'unclear']);

function mapReport(row) {
  return {
    id: Number(row.id),
    chatId: String(row.chat_id),
    groupId: row.group_id === null || row.group_id === undefined ? null : Number(row.group_id),
    groupName: row.group_name || null,
    triggerMessageId: Number(row.trigger_message_id),
    kind: row.kind,
    triggeredBy: row.triggered_by === null || row.triggered_by === undefined ? null : String(row.triggered_by),
    triggeredByName: row.triggered_by_name || null,
    photoCount: Number(row.photo_count) || 0,
    videoCount: Number(row.video_count) || 0,
    excludedCount: Number(row.excluded_count) || 0,
    parts: Number(row.parts) || 0,
    status: row.status,
    reason: row.reason || null,
    aiAssisted: Boolean(row.ai_assisted),
    aiProvider: row.ai_provider || null,
    createdAt: row.created_at || null,
    sentAt: row.sent_at || null,
  };
}

/**
 * Claim this word. `ai_assisted` is written explicitly — FALSE until a model's
 * answer is actually used.
 *
 * @returns {Promise<number|null>} the report id, or null when it was already claimed
 */
async function claimReport({
  chatId, groupId, triggerMessageId, kind, triggeredBy = null, triggeredByName = null,
}) {
  const { rows } = await query(
    `INSERT INTO truck_photo_reports
       (chat_id, group_id, trigger_message_id, kind, triggered_by, triggered_by_name, status, ai_assisted)
     VALUES ($1::bigint, $2, $3, $4, $5::bigint, $6, 'pending', FALSE)
     ON CONFLICT (chat_id, trigger_message_id) DO NOTHING
     RETURNING id`,
    [String(chatId), groupId, triggerMessageId, kind, triggeredBy, triggeredByName],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/**
 * What became of a claim.
 *
 * @returns {Promise<boolean>} false when the row was no longer pending
 */
async function finishReport(id, {
  status, reason = null, photoCount = 0, excludedCount = 0, parts = 0,
  aiAssisted = false, aiProvider = null, sent = false, videoCount = 0,
}) {
  if (!STATUSES.includes(status) || status === 'pending') throw new Error(`not a finished status: ${status}`);
  const result = await query(
    `UPDATE truck_photo_reports
        SET status = $2, reason = $3, photo_count = $4, excluded_count = $5, parts = $6,
            ai_assisted = $7, ai_provider = $8, sent_at = CASE WHEN $9 THEN NOW() ELSE sent_at END,
            video_count = $10
      WHERE id = $1 AND status = 'pending'`,
    [id, status, reason, photoCount, excludedCount, parts, Boolean(aiAssisted), aiProvider, Boolean(sent), videoCount],
  );
  return (result.rowCount || 0) > 0;
}

/** The group's last delivered outbound before `before`: `{at, photoCount, videoCount}` or null. */
async function lastSentOutbound(groupId, before) {
  if (groupId === null || groupId === undefined) return null;
  const { rows } = await query(
    `SELECT created_at, sent_at, photo_count, video_count FROM truck_photo_reports
      WHERE group_id = $1 AND kind = 'outbound' AND status = 'sent' AND created_at < $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [groupId, before],
  );
  if (!rows[0]) return null;
  return {
    at: rows[0].created_at, photoCount: Number(rows[0].photo_count) || 0, videoCount: Number(rows[0].video_count) || 0,
  };
}

/** The latest reports, for Settings → Truck Photos. No message text exists to show. */
async function listRecentReports(limit = 20) {
  const { rows } = await query(
    `SELECT r.*, g.group_name FROM truck_photo_reports r
       LEFT JOIN groups g ON g.id = r.group_id
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 20, 1), 100)],
  );
  return rows.map(mapReport);
}

/**
 * Claims a stopped process left behind: still `pending` after `olderThanMinutes`
 * and not among `exceptIds` (the reports the running process is still working
 * on) are finished as `failed` with `reason`, and returned so the recipient can
 * be told.
 */
async function failStaleReports(olderThanMinutes, reason, exceptIds = []) {
  const keep = (exceptIds || []).map(Number).filter(Number.isInteger);
  const { rows } = await query(
    `UPDATE truck_photo_reports r
        SET status = 'failed', reason = $2
       FROM (SELECT id FROM truck_photo_reports
              WHERE status = 'pending' AND created_at < NOW() - ($1 || ' minutes')::interval
                AND NOT (id = ANY($3::bigint[]))
              ORDER BY created_at
              LIMIT 50) stale
      WHERE r.id = stale.id AND r.status = 'pending'
      RETURNING r.*, (SELECT group_name FROM groups g WHERE g.id = r.group_id) AS group_name`,
    [String(Math.max(1, Number(olderThanMinutes) || 30)), reason, keep],
  );
  return rows.map(mapReport);
}

module.exports = {
  STATUSES,
  claimReport,
  finishReport,
  lastSentOutbound,
  listRecentReports,
  failStaleReports,
  __mapReportForTests: mapReport,
};
