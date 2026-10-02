/**
 * Following a Telegram group that moved to a new id.
 *
 * Two ways Wenze learns of a move, both handled here:
 *   1. A send fails and Telegram's error names the new id
 *      (`parameters.migrate_to_chat_id`). This is the one that matters: it
 *      fires even if the bot never saw the group's own "upgraded" message.
 *   2. The bot sees the group's service message (`migrate_to_chat_id` /
 *      `migrate_from_chat_id`).
 *
 * The move itself is database/telegramChatMigration.js — one transaction, one
 * audit row, idempotent. This file reads the new id, applies the move, and
 * drops the settings caches so the very next send uses it. It SENDS nothing:
 * the caller that noticed the move announces it, which keeps this module free
 * of the notification layer it is called from.
 */
const { migrationTargetFrom, describeMigration } = require('../lib/telegram/chatMigration');

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    store: require('../database/telegramChatMigration'),
    // Every settings module that caches a table holding a destination. A
    // cache that kept the old id would undo the move for up to 30 seconds.
    caches: [
      require('../database/operationalNotificationSettings'),
      require('../database/messageRoutingSettings'),
      require('../database/financeSettings'),
      require('../database/bolPodForwardingSettings'),
    ],
  };
  /* eslint-enable global-require */
}

/** Apply a known move. Never throws; a failed move returns null and logs. */
async function followMigration(oldChatId, newChatId, { reason = null, deps = defaultDeps() } = {}) {
  try {
    const summary = await deps.store.followChatMigration(oldChatId, newChatId, { reason });
    for (const cache of deps.caches || []) {
      try { cache.invalidateCache?.(); } catch (_) { /* a cache that cannot be cleared expires on its own */ }
    }
    if (!summary.nothingToDo) {
      const moved = summary.changed.reduce((n, c) => n + c.rows, 0);
      console.log(`[TG-MIGRATE] followed a group to its new id: ${moved} setting(s), `
        + `${summary.groupMoved} group row(s), ${summary.pointed} queued notice(s), ${summary.requeued} resent.`);
    }
    return summary;
  } catch (err) {
    console.error('[TG-MIGRATE] could not follow the group to its new id:', err.message);
    return null;
  }
}

/**
 * When a send failed because the group moved: follow it and hand back the new
 * id so the caller can send again. Null when the failure was anything else.
 */
async function followMigrationFromError(err, oldChatId, { deps = defaultDeps() } = {}) {
  const newChatId = migrationTargetFrom(err);
  if (!newChatId) return null;
  const summary = await followMigration(oldChatId, newChatId, {
    reason: 'a send failed: Telegram reported the group was upgraded to a supergroup', deps,
  });
  return { newChatId, summary };
}

/** The notice the caller sends once, or null when the move changed nothing. */
function migrationNotice(summary) {
  if (!summary || summary.nothingToDo) return null;
  return {
    category: 'self_healing',
    title: 'A Telegram group moved — Wenze followed it',
    lines: describeMigration(summary),
    subjectType: 'telegram_chat',
    subjectId: String(summary.from),
    discriminator: String(summary.to),
  };
}

module.exports = { followMigration, followMigrationFromError, migrationNotice };
