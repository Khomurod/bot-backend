/**
 * Home-Time request CLOSING data access — a small, focused module so the large
 * database/homeTime.js stays within the maintainability line limit. It reuses the
 * status constants exported by database/homeTime so "open" means exactly one thing
 * across the reminder sweep, the duplicate guard, and the cleanup sweep.
 *
 * THIS IS HOUSEKEEPING, NOT A VERDICT. A request used to be stamped 'expired'
 * when its dates passed, and that word then travelled: a sweep announced how
 * many had "expired without an answer" and the retention watch counted it as
 * the company failing the driver. Nothing about a finished date range says
 * either. The row is now 'closed' — it is no longer open, and that is the whole
 * claim. Nothing here is evidence that a driver did or did not go home; that
 * question is answered by the Board and the driver's own messages.
 */
const { query } = require('./db');
const { OPEN_REQUEST_STATUSES } = require('./homeTime/requests');

/**
 * Every still-open request (a posted card awaiting a decision, or any awaiting /
 * unanswered clarification) — the candidate set for the outdated-request sweep.
 * Oldest first. Returns raw home_time_requests rows (all columns, so the caller
 * can judge staleness and rebuild the Telegram card without a second read).
 */
async function listOpenHomeTimeRequests() {
  const res = await query(
    `SELECT * FROM home_time_requests
      WHERE status = ANY($1)
      ORDER BY requested_at ASC`,
    [OPEN_REQUEST_STATUSES]
  );
  return res.rows;
}

/**
 * Atomically close a request whose window has passed — but ONLY if it is still
 * open, so a late reply that landed first always wins. Preserves every other
 * column (original dates, notes, source, AI reasoning, requester, reminder
 * history); only the status and the (now-moot) reminder schedule change.
 * Returns the updated row when THIS caller won the race, otherwise null.
 */
async function closeOutdatedHomeTimeRequest(id) {
  const res = await query(
    `UPDATE home_time_requests
        SET status = 'closed', next_reminder_at = NULL
      WHERE id = $1 AND status = ANY($2)
      RETURNING *`,
    [id, OPEN_REQUEST_STATUSES]
  );
  return res.rows[0] || null;
}

module.exports = { listOpenHomeTimeRequests, closeOutdatedHomeTimeRequest };
