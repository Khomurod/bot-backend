/**
 * DURABLE missing-video recovery jobs — read side for the admin panel.
 *
 * One row per safety event that was alerted WITHOUT dashcam video. The separate
 * `samsara-integration` poller creates and works these rows; this app owns the
 * canonical DDL (migration 0013) and reads them so "why did that event never
 * get its video?" is answerable from the admin panel instead of Render logs.
 *
 * READ-ONLY ON PURPOSE. Nothing here writes a job: two processes racing to
 * advance the same recovery is exactly the bug the durable table exists to
 * prevent, and the poller is the one with the Samsara credential and the
 * Telegram bots.
 */
const { query } = require('./db');

/** The states a job can be in, in the order an operator reads them. */
const STATUSES = [
  'pending_recheck',
  'pending_retrieval',
  'video_available',
  'completed',
  'no_video',
  'failed',
];

/** How many jobs sit in each state right now. Zero-filled so a state never vanishes. */
async function getSamsaraVideoRecoverySummary() {
  try {
    const res = await query(
      `SELECT status, COUNT(*)::int AS count,
              MIN(next_check_at) FILTER (WHERE status IN ('pending_recheck','pending_retrieval','video_available')) AS next_due_at
         FROM samsara_video_recovery_jobs
        GROUP BY status`
    );
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    let nextDueAt = null;
    for (const row of res.rows) {
      byStatus[row.status] = row.count;
      if (row.next_due_at && (!nextDueAt || row.next_due_at < nextDueAt)) nextDueAt = row.next_due_at;
    }
    return { available: true, byStatus, nextDueAt };
  } catch (err) {
    // The table only exists once migration 0013 has run. The Samsara settings
    // page must still render without it.
    console.warn('[SAMSARA RECOVERY] summary unavailable:', err.message);
    return { available: false, byStatus: Object.fromEntries(STATUSES.map((s) => [s, 0])), nextDueAt: null };
  }
}

/**
 * The most recent jobs, newest first, WITHOUT the payload columns.
 *
 * `raw_event` and `targets` are deliberately not selected: they are large, they
 * are the worker's business, and neither belongs in an HTTP response. Nothing
 * returned here contains a signed media URL or a credential.
 */
async function listSamsaraVideoRecoveryJobs({ limit = 50, status = null } = {}) {
  const bounded = Math.min(200, Math.max(1, Number(limit) || 50));
  const params = [bounded];
  let where = '';
  if (status && STATUSES.includes(status)) {
    params.push(status);
    where = `WHERE status = $${params.length}`;
  }
  try {
    const res = await query(
      `SELECT id, samsara_event_id, vehicle_id, event_time, is_speeding, status,
              next_check_at, attempts, retrieval_id, retrieval_requested_at,
              last_error, created_at, updated_at, completed_at,
              jsonb_array_length(targets) AS target_count
         FROM samsara_video_recovery_jobs
         ${where}
        ORDER BY created_at DESC
        LIMIT $1`,
      params
    );
    return res.rows;
  } catch (err) {
    console.warn('[SAMSARA RECOVERY] listing unavailable:', err.message);
    return [];
  }
}

module.exports = {
  STATUSES,
  getSamsaraVideoRecoverySummary,
  listSamsaraVideoRecoveryJobs,
};
