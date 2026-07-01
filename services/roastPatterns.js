/**
 * Pure helpers for the "roast" feature: detect whether a group message is a
 * reply to the bot or an @-mention of the bot / the configured target user.
 * No DB / network so these are unit-testable in isolation.
 */
function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase().replace(/^@/, '');
}

function isGroupChat(chat) {
  return chat?.type === 'group' || chat?.type === 'supergroup';
}

function isReplyToBot(message, botId) {
  const replyFrom = message?.reply_to_message?.from;
  if (!replyFrom?.is_bot || botId == null) return false;
  return String(replyFrom.id) === String(botId);
}

/** Pull @usernames mentioned in a message from entities, with a regex fallback. */
function extractMentionUsernames(message) {
  const text = message?.text || message?.caption || '';
  const entities = message?.entities || message?.caption_entities || [];
  const found = new Set();

  for (const ent of Array.isArray(entities) ? entities : []) {
    if (ent?.type === 'mention' && typeof text === 'string') {
      const slice = text.slice(ent.offset, ent.offset + ent.length);
      const handle = normalizeUsername(slice);
      if (handle) found.add(handle);
    }
  }

  for (const match of String(text).matchAll(/@([a-z0-9_]{3,})/gi)) {
    found.add(normalizeUsername(match[1]));
  }

  return [...found];
}

function messageMentionsUsername(message, username) {
  const target = normalizeUsername(username);
  if (!target) return false;
  return extractMentionUsernames(message).includes(target);
}

/** Does this message target the bot at all (mention or reply to its own message)? */
function isRoastTrigger(message, { botId, botUsername } = {}) {
  if (isReplyToBot(message, botId)) return true;
  if (botUsername && messageMentionsUsername(message, botUsername)) return true;
  return false;
}

/** Is the message author the configured roast target (by username)? */
function isFromTargetUser(from, targetUsername) {
  const target = normalizeUsername(targetUsername);
  if (!target) return false;
  return normalizeUsername(from?.username) === target;
}

module.exports = {
  normalizeUsername,
  isGroupChat,
  isReplyToBot,
  extractMentionUsernames,
  messageMentionsUsername,
  isRoastTrigger,
  isFromTargetUser,
};
