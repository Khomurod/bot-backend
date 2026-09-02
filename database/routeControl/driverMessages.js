/**
 * Driver-group MESSAGE bookkeeping for a route — database helpers.
 *
 * Records which Telegram message carries a route and how it has been edited,
 * which is what lets the monitor convert an existing text post IN PLACE with
 * editMessageMedia instead of replacing it with a new one (APP_BRIEF §9).
 *
 * Split out of database/routeControl.js, which re-exports every symbol here.
 */
const { query } = require('../pool');

/**
 * Record a successful "route message sent to driver group" delivery, including
 * HOW it went out (photo | photo+text | text), the screenshot delivery error
 * when the photo could not be sent (NULL when it was, or none stored), and the
 * ordered list of Telegram messages that make up the delivery (so each part can
 * later be edited in place). A fresh send resets the in-place-edit bookkeeping.
 *
 * @param {{ messages?: Array<{message_id:number, kind:'photo'|'text'}> }} p
 */
async function recordDriverGroupMessageSent(id, {
  telegramMessageId = null, sentBy = null, via = null, screenshotError = null, messages = null,
} = {}) {
  const res = await query(
    `UPDATE route_assignments
       SET driver_group_message_sent_at = NOW(),
           driver_group_message_id = $2,
           driver_group_message_sent_by = $3,
           driver_group_message_via = $4,
           screenshot_send_error = $5,
           driver_group_messages = $6::jsonb,
           driver_group_message_edited_at = NULL,
           driver_group_message_edit_error = NULL,
           updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [
      id, telegramMessageId ?? null, sentBy ? String(sentBy).slice(0, 128) : null,
      via ? String(via).slice(0, 32) : null,
      screenshotError ? String(screenshotError).slice(0, 300) : null,
      Array.isArray(messages) && messages.length ? JSON.stringify(messages) : null,
    ]
  );
  return res.rows[0] || null;
}

/**
 * Record the outcome of an IN-PLACE edit of the already-sent driver-group route
 * message(s). Stamps when the edit ran, the machine-readable edit error (NULL
 * when the requested edits fully succeeded), and refreshes the screenshot
 * delivery status. `via`/`screenshotError`/`messages` are only written when
 * explicitly provided (pass undefined to leave a column unchanged) — so a
 * routine edit that keeps the same message ids does NOT rewrite the list, while
 * a text→photo conversion (same id, new kind) DOES persist the new `via` +
 * `driver_group_messages` so later replacements follow the photo branch.
 *
 * @param {{ messages?: Array<{message_id:number, kind:'photo'|'text'}> }} p
 */
async function recordDriverGroupMessageEdit(id, {
  via = undefined, screenshotError = undefined, editError = null, messages = undefined,
} = {}) {
  const sets = [
    'driver_group_message_edited_at = NOW()',
    'driver_group_message_edit_error = $2',
    'updated_at = NOW()',
  ];
  const values = [id, editError ? String(editError).slice(0, 300) : null];
  let i = 3;
  if (via !== undefined) {
    sets.push(`driver_group_message_via = $${i++}`);
    values.push(via ? String(via).slice(0, 32) : null);
  }
  if (screenshotError !== undefined) {
    sets.push(`screenshot_send_error = $${i++}`);
    values.push(screenshotError ? String(screenshotError).slice(0, 300) : null);
  }
  if (messages !== undefined) {
    sets.push(`driver_group_messages = $${i++}::jsonb`);
    values.push(Array.isArray(messages) && messages.length ? JSON.stringify(messages) : null);
  }
  const res = await query(
    `UPDATE route_assignments SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

module.exports = {
  recordDriverGroupMessageSent,
  recordDriverGroupMessageEdit,
};
