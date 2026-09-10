/**
 * Correcting the durable queues — currently one action, and it is a decision
 * about giving up rather than about retrying.
 *
 * Split out of `actions.js` rather than added to it: that file was at 337 lines
 * and this is a different domain from driver identity and home-time cycles. It
 * registers through the same registry, so nothing about tiering, auditing or
 * reversal changes.
 */
const { StaleCorrectionError, assertUnchangedSince } = require('./evidence');

/**
 * Mark exhausted internal home-time alerts terminal.
 *
 * 98 rows in production, every one at attempts = 6 = MAX_ATTEMPTS, every one
 * `400: Bad Request: chat not found` — a dropped minus sign in
 * `internal_clarification_group_id`. Migration 0014 fixed the id. It did not,
 * and must not, fix the pile.
 *
 * THIS DOES NOT RE-SEND ANYTHING, and that is the whole reason it exists as a
 * correction rather than a retry. Re-driving months of stale home-time alerts
 * into a live staff chat would be its own incident. What it changes is the
 * CLAIM: `'failed'` is the outbox's "we are still looking at this" state, and
 * `countExhaustedInternalAlerts` puts it on `/api/health`, so leaving them there
 * reports 98 problems forever and trains everyone to ignore the number — the
 * exact failure that let the original 101 sit unnoticed for months.
 *
 * Nothing is deleted. The row, the attempt count and
 * `internal_alert_last_error` all stay, so what was lost is still answerable.
 *
 * Tier `auto` because it invents no fact: the rows are already terminal in
 * substance and this records that they are.
 */
const abandonExhaustedInternalAlerts = {
  key: 'home_time.abandon_exhausted_alerts',
  tier: 'auto',
  subjectType: 'outbox',
  describe: (p) => `Mark ${p.requestIds?.length || 0} undeliverable internal alert(s) abandoned `
    + '(they are NOT re-sent)',

  async apply({ requestIds }, client) {
    const ids = (Array.isArray(requestIds) ? requestIds : [])
      .map(Number)
      .filter(Number.isInteger);
    if (!ids.length) throw new StaleCorrectionError('No exhausted alerts were named.');

    // Re-derived from the LIVE rows, not trusted from the sweep's payload: the
    // drain runs every few minutes and one of these could have been re-driven
    // and delivered between the sweep and this apply. Only rows still reading
    // 'failed' are touched.
    const live = await client.query(
      `SELECT id FROM home_time_requests
        WHERE id = ANY($1::int[]) AND internal_alert_state = 'failed'
        ORDER BY id
          FOR UPDATE`,
      [ids]
    );
    const moving = live.rows.map((r) => r.id);
    if (!moving.length) {
      throw new StaleCorrectionError('None of those alerts is still exhausted.');
    }

    await client.query(
      `UPDATE home_time_requests
          SET internal_alert_state = 'abandoned'
        WHERE id = ANY($1::int[])`,
      [moving]
    );

    return {
      // The ids ACTUALLY moved, which is what revert must put back — not the
      // ids the sweep proposed.
      oldValues: { state: 'failed', requestIds: moving },
      newValues: { state: 'abandoned', requestIds: moving },
      affectedRecords: moving.map((id) => ({ table: 'home_time_requests', id })),
    };
  },

  async revert(correction, client) {
    const ids = (correction.old_values?.requestIds || []).map(Number).filter(Number.isInteger);
    if (!ids.length) throw new StaleCorrectionError('This correction recorded no alert ids.');

    const current = await client.query(
      `SELECT id, internal_alert_state FROM home_time_requests
        WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
      [ids]
    );
    // Restore only while every row still holds what this correction set. A row
    // somebody has since re-driven and delivered must not be dragged back to
    // 'failed' by an undo of a different decision.
    for (const row of current.rows) {
      assertUnchangedSince({ state: 'abandoned' }, { state: row.internal_alert_state }, `Alert ${row.id}`);
    }
    if (current.rows.length !== ids.length) {
      throw new StaleCorrectionError('Some of those requests no longer exist.');
    }

    await client.query(
      `UPDATE home_time_requests
          SET internal_alert_state = 'failed'
        WHERE id = ANY($1::int[])`,
      [ids]
    );
  },
};

module.exports = { abandonExhaustedInternalAlerts };
