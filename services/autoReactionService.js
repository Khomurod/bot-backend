/**
 * Automatic message reactions — runtime service.
 *
 * The bot calls applyAutoReaction() for every group message it sees. To avoid a
 * database hit per message, the enabled rules are cached in memory as fast
 * lookup maps and refreshed at most once per TTL; the admin API calls
 * invalidateAutoReactionCache() after any change so edits take effect promptly.
 *
 * Reacting is strictly best-effort: any failure (Telegram API, not an admin in
 * the chat, unsupported emoji) is swallowed so it can never disturb the rest of
 * the message pipeline.
 */
const autoReactionsDb = require('../database/autoReactions');
const { matchReactionRule, buildReactionIndexes } = require('./autoReactionConstants');

const CACHE_TTL_MS = 30 * 1000;

// Telegram service/system messages carry one of these fields instead of user
// content; reacting to them is pointless and can error, so they are skipped.
const SERVICE_MESSAGE_FIELDS = [
  'new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo',
  'delete_chat_photo', 'group_chat_created', 'supergroup_chat_created',
  'channel_chat_created', 'migrate_to_chat_id', 'migrate_from_chat_id',
  'pinned_message', 'message_auto_delete_timer_changed', 'proximity_alert_triggered',
  'video_chat_scheduled', 'video_chat_started', 'video_chat_ended',
  'video_chat_participants_invited',
];

let cache = { byUserId: new Map(), byUsername: new Map() };
let loadedAt = 0;
let inFlight = null;

async function reload() {
  const rows = await autoReactionsDb.listEnabledAutoReactionRules();
  cache = buildReactionIndexes(rows);
  loadedAt = Date.now();
  return cache;
}

/** Force the next lookup to reload from the database. */
function invalidateAutoReactionCache() {
  loadedAt = 0;
}

/** Return current indexes, refreshing in the background when the TTL expired. */
async function getIndexes() {
  if (loadedAt === 0) {
    // Cold (or invalidated): load once, sharing a single in-flight promise.
    if (!inFlight) inFlight = reload().finally(() => { inFlight = null; });
    return inFlight;
  }
  if (Date.now() - loadedAt > CACHE_TTL_MS && !inFlight) {
    // Warm but stale: refresh without blocking this message; serve current data.
    inFlight = reload().catch(() => cache).finally(() => { inFlight = null; });
  }
  return cache;
}

function isServiceMessage(message) {
  return SERVICE_MESSAGE_FIELDS.some((field) => message[field] !== undefined);
}

/**
 * React to a message if its sender has an enabled rule. Safe to call on every
 * message; never throws. `telegram` is a Telegraf telegram client.
 */
async function applyAutoReaction(telegram, message) {
  try {
    if (!telegram || !message || !message.message_id) return false;
    const from = message.from;
    if (!from || from.is_bot || from.id == null) return false;
    if (isServiceMessage(message)) return false;

    const indexes = await getIndexes();
    const rule = matchReactionRule(indexes, from);
    if (!rule || !rule.emoji) return false;

    const chatId = message.chat?.id;
    if (chatId == null) return false;
    const reaction = [{ type: 'emoji', emoji: rule.emoji }];
    if (typeof telegram.setMessageReaction === 'function') {
      await telegram.setMessageReaction(chatId, message.message_id, reaction);
    } else if (typeof telegram.callApi === 'function') {
      await telegram.callApi('setMessageReaction', {
        chat_id: chatId, message_id: message.message_id, reaction,
      });
    } else {
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[AUTO-REACTION] Could not react (non-fatal):', err.message);
    return false;
  }
}

module.exports = {
  applyAutoReaction,
  invalidateAutoReactionCache,
  // Exposed for tests.
  _reload: reload,
  _reset: () => { cache = { byUserId: new Map(), byUsername: new Map() }; loadedAt = 0; inFlight = null; },
};
