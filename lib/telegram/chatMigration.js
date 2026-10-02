/**
 * When Telegram moves a group to a new id. PURE — no I/O.
 *
 * A basic group that is upgraded to a supergroup (turning on topics, making
 * history visible, passing 200 members, giving someone certain admin rights)
 * gets a NEW chat id. Every send to the old id fails from that moment with
 * "Bad Request: group chat was upgraded to a supergroup chat", and Telegram
 * puts the new id in the error itself: `parameters.migrate_to_chat_id`.
 *
 * On 2026-10-02 that is exactly why none of the home-time notices of the past
 * week had reached the three managers: their group had been upgraded, and the
 * only thing in the application that followed a migration was the
 * `groups.telegram_group_id` row — never the settings that NAME a destination.
 *
 * This module knows where those destinations live, and how to read the new id
 * out of a failure. The database module applies it; nothing here writes.
 */

/**
 * Every setting that names a chat Wenze SENDS to (or, for the finance group,
 * reads from). A destination added to a settings table belongs here too —
 * `tests/telegramChatMigration.test.js` cross-checks this list against the
 * schema so a new one cannot be missed silently.
 */
const DESTINATION_SETTINGS = Object.freeze([
  { table: 'home_time_settings', column: 'completed_notify_group_id', type: 'text' },
  { table: 'home_time_settings', column: 'internal_clarification_group_id', type: 'text' },
  { table: 'message_group_settings', column: 'dispatch_review_group_id', type: 'text' },
  { table: 'message_group_settings', column: 'mileage_bonus_group_id', type: 'text' },
  { table: 'message_group_settings', column: 'raise_results_group_id', type: 'text' },
  { table: 'message_group_settings', column: 'road_bonus_group_id', type: 'text' },
  { table: 'operational_notification_settings', column: 'default_chat_id', type: 'text' },
  { table: 'ai_policy_watcher_settings', column: 'notify_chat_id', type: 'text' },
  { table: 'bol_pod_forwarding_settings', column: 'central_group_id', type: 'bigint' },
  { table: 'finance_settings', column: 'chat_id', type: 'text' },
  { table: 'finance_settings', column: 'weekly_report_chat_id', type: 'text' },
]);

/** The per-category routing map, `{ category: chatId }`. */
const DESTINATION_MAPS = Object.freeze([
  { table: 'operational_notification_settings', column: 'category_chat_ids' },
]);

/**
 * How far back an undelivered notice is resent once its chat is found again.
 * Older ones stay failed: delivering a backlog of stale alerts into a live
 * staff chat is what this repository decided NOT to do with 98 expired ones.
 * Two days is "what happened recently", not history.
 */
const REQUEUE_WITHIN_HOURS = 48;

/** A chat id as a canonical string, or null. Telegram group ids are negative integers. */
function normaliseChatId(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return /^-?\d{5,20}$/.test(s) ? s : null;
}

/** The new chat id Telegram reports in a failed call, or null when it is not a migration. */
function migrationTargetFrom(err) {
  const raw = err?.response?.parameters?.migrate_to_chat_id
    ?? err?.parameters?.migrate_to_chat_id
    ?? err?.on?.payload?.parameters?.migrate_to_chat_id
    ?? null;
  return normaliseChatId(raw);
}

/** A routing map with every value equal to `from` replaced by `to`. */
function rewriteChatMap(map, from, to) {
  const out = {};
  let changed = 0;
  for (const [key, value] of Object.entries(map || {})) {
    if (normaliseChatId(value) === from) { out[key] = to; changed += 1; } else out[key] = value;
  }
  return { map: out, changed };
}

/** The words the owner reads after Wenze followed a move. No ids, no tokens. */
function describeMigration(summary) {
  const settings = (summary?.changed || []).reduce((n, c) => n + (Number(c.rows) || 0), 0);
  const lines = [
    `Telegram gave one of Wenze's groups a new id (it became a supergroup). Wenze moved ${settings} setting(s) to the new id.`,
  ];
  if (summary?.requeued > 0) {
    lines.push(`${summary.requeued} notice(s) from the last ${REQUEUE_WITHIN_HOURS} hours that could not be delivered are being sent again.`);
  }
  if (summary?.groupConflict) {
    lines.push('The new group is already known to Wenze as a separate group, so the old group record was left as it is — worth a look.');
  }
  return lines;
}

module.exports = {
  DESTINATION_SETTINGS,
  DESTINATION_MAPS,
  REQUEUE_WITHIN_HOURS,
  normaliseChatId,
  migrationTargetFrom,
  rewriteChatMap,
  describeMigration,
};
