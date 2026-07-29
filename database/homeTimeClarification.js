/**
 * Home-Time clarification worker — database helpers.
 *
 * The restart-safe reminder sweep and the internal-alert claim live here, split
 * out of database/homeTime.js so both stay within the project's per-file line
 * limit. Sibling of database/homeTimeExpiry.js and re-exported from
 * database/homeTime.js, so every existing importer is unchanged.
 *
 * Everything in this module is an ATOMIC claim: each write is guarded on the
 * state it expects to find, and returns the row only to the caller that won. No
 * in-memory locks, no long-lived timers — overlapping ticks and process restarts
 * are safe by construction.
 */
const { query } = require('./db');

// Statuses of a clarification that is still waiting on the driver.
const AWAITING_STATUSES = ['awaiting_dates', 'awaiting_home_start', 'awaiting_return_to_road'];

/**
 * Open clarifications whose next reminder is due, with the group + driver labels
 * needed to reply-and-tag. Excludes flows that already spent both reminders.
 */
async function listDueHomeTimeReminders(nowIso, { limit = 50, maxReminders = 2 } = {}) {
  const res = await query(
    `SELECT r.*, g.group_name, g.telegram_group_id AS group_telegram_id, g.active AS group_active,
            dp.first_name, dp.last_name, dp.unit_number, dp.driver_type,
            dp.telegram_user_id, dp.telegram_username
     FROM home_time_requests r
     JOIN groups g ON g.id = r.group_id
     LEFT JOIN driver_profiles dp ON dp.group_id = r.group_id
     WHERE r.status = ANY($1)
       AND r.next_reminder_at IS NOT NULL
       AND r.next_reminder_at <= $2
       AND r.reminder_count < $3
     ORDER BY r.next_reminder_at ASC
     LIMIT $4`,
    [AWAITING_STATUSES, nowIso, maxReminders, limit]
  );
  return res.rows;
}

/**
 * Atomically claim a due reminder: bump reminder_count and move next_reminder_at
 * forward (or to NULL when the final reminder was just claimed), only if the row
 * is still due and its reminder_count has not changed since we read it. Returns
 * the updated row when THIS worker won the claim, or null otherwise — the guard
 * that stops overlapping workers / restarts from double-sending.
 */
async function claimHomeTimeReminder(id, {
  expectedReminderCount, nowIso, nextReminderAt = null,
}) {
  const res = await query(
    `UPDATE home_time_requests
       SET reminder_count = reminder_count + 1,
           last_reminder_at = $2,
           next_reminder_at = $3
     WHERE id = $1
       AND reminder_count = $4
       AND next_reminder_at IS NOT NULL
       AND next_reminder_at <= $2
       AND status = ANY($5)
     RETURNING *`,
    [id, nowIso, nextReminderAt, expectedReminderCount, AWAITING_STATUSES]
  );
  return res.rows[0] || null;
}

/**
 * Stand down a scheduled reminder WITHOUT sending it and WITHOUT consuming one
 * of the driver's two allowed reminders.
 *
 * Used when driver messaging is switched off while reminders are already
 * scheduled: the clock is cleared so nothing can later leak into the driver
 * group, but reminder_count is left alone and the status stays awaiting_* so the
 * request remains open and visible for staff to resolve. Because the schedule is
 * cleared rather than deferred, switching driver messaging back on replays
 * nothing and fires no accumulated backlog.
 *
 * Idempotent: a row whose schedule is already clear simply matches nothing.
 */
async function cancelHomeTimeReminderSchedule(id) {
  const res = await query(
    `UPDATE home_time_requests
       SET next_reminder_at = NULL
     WHERE id = $1 AND next_reminder_at IS NOT NULL
     RETURNING *`,
    [id]
  );
  return res.rows[0] || null;
}

/**
 * Atomically claim the right to send THE internal clarification alert for a
 * request. Mirrors markHomeTimeAcknowledged: only the first caller gets a row
 * back, so concurrent ticks, retries and process restarts can never post the
 * same request to the internal group twice.
 *
 * @returns {object|null} the claimed row, or null when an alert already went out
 */
async function claimInternalClarificationAlert(id) {
  const res = await query(
    `UPDATE home_time_requests
       SET internal_alert_sent_at = NOW()
     WHERE id = $1 AND internal_alert_sent_at IS NULL
     RETURNING *`,
    [id]
  );
  return res.rows[0] || null;
}

/**
 * Release an internal-alert claim after the send itself failed, so the next
 * sweep can retry instead of the request being silently marked as alerted.
 */
async function releaseInternalClarificationAlert(id) {
  const res = await query(
    `UPDATE home_time_requests
       SET internal_alert_sent_at = NULL
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return res.rows[0] || null;
}

/** After the final reminder goes unanswered → flag for manual follow-up. */
async function markHomeTimeClarificationUnanswered(id) {
  const res = await query(
    `UPDATE home_time_requests
       SET status = 'clarification_unanswered', next_reminder_at = NULL
     WHERE id = $1 AND status = ANY($2)
     RETURNING *`,
    [id, AWAITING_STATUSES]
  );
  return res.rows[0] || null;
}

module.exports = {
  AWAITING_STATUSES,
  listDueHomeTimeReminders,
  claimHomeTimeReminder,
  cancelHomeTimeReminderSchedule,
  claimInternalClarificationAlert,
  releaseInternalClarificationAlert,
  markHomeTimeClarificationUnanswered,
};
