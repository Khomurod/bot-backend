'use strict';

/**
 * The `groups` row a Telegram message needs, kept for a few minutes.
 *
 * WHY. Every message in a group read its `groups` row twice: once echoed back
 * by the registration upsert, and once more by the message handler. That was
 * about 1.5 KB of the 5.7 KB a driver's message cost the hosted database in
 * October 2026, when its monthly transfer allowance was nearly spent. A row
 * that changes a few times a month was being re-read some ten thousand times
 * a day.
 *
 * THE RULE THAT KEEPS IT TRUE. Every write to `groups` in this process calls
 * `forgetGroupRows()`:
 *   - database/groups.js and database/db.js;
 *   - database/driverProfiles.js;
 *   - database/telegramChatMigration.js;
 *   - every correction that commits (services/operations/corrections/apply.js).
 * A writer that does not is bounded by the TTL, five minutes. The one write
 * deliberately left out is `recordGroupMessageSeen`. It happens on nearly every
 * message, its timestamp is a diagnostic, and nothing on the message path
 * reads it.
 *
 * Callers get a COPY, so a caller that annotates the row cannot change what
 * the next message sees.
 *
 * Owned here and nowhere else.
 */

const GROUP_ROW_TTL_MS = 5 * 60 * 1000;
/** A ceiling, not a working size: there are a few hundred groups. */
const MAX_ROWS = 2000;

const rows = new Map();

/** A Telegram chat id as the key, whether it arrives as a number or as pg's bigint string. */
function keyOf(telegramGroupId) {
  return telegramGroupId == null ? null : String(telegramGroupId);
}

/** The cached row for this chat, or null when there is none or it is too old. */
function cachedGroupRow(telegramGroupId, now = Date.now()) {
  const key = keyOf(telegramGroupId);
  const hit = key ? rows.get(key) : null;
  if (!hit || now - hit.at >= GROUP_ROW_TTL_MS) return null;
  return { ...hit.row };
}

/** Remember a row just read from, or written to, the table. */
function rememberGroupRow(row, now = Date.now()) {
  const key = keyOf(row?.telegram_group_id);
  if (!key) return;
  if (rows.size >= MAX_ROWS) rows.clear();
  rows.set(key, { row: { ...row }, at: now });
}

/** A `groups` row changed: the next read goes to the table. */
function forgetGroupRows() {
  rows.clear();
}

module.exports = {
  GROUP_ROW_TTL_MS,
  cachedGroupRow,
  rememberGroupRow,
  forgetGroupRows,
};
