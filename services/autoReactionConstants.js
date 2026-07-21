/**
 * Automatic message reactions — pure constants and helpers.
 *
 * An admin picks a Telegram user (from the seen-users list or by typing a
 * username) and a reaction emoji; the bot then reacts to every message that
 * user posts. Everything here is side-effect free so it can be unit tested.
 */

// The emoji reactions Telegram's Bot API accepts for a normal (non-premium)
// `ReactionTypeEmoji`. Sending anything outside this set makes
// setMessageReaction fail, so the admin only ever chooses from this list and
// the API layer validates against it. Order roughly matches Telegram's picker.
const ALLOWED_REACTION_EMOJIS = [
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱',
  '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡',
  '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '💯', '🤣', '⚡', '🍌',
  '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴',
  '😭', '🤓', '👻', '👀', '🎃', '🙈', '😇', '😨', '🤝', '✍',
  '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿', '🆒', '💘',
  '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷', '😡',
];

const ALLOWED_REACTION_SET = new Set(ALLOWED_REACTION_EMOJIS);

/** True when `emoji` is a reaction Telegram will accept from a normal bot. */
function isAllowedReactionEmoji(emoji) {
  return typeof emoji === 'string' && ALLOWED_REACTION_SET.has(emoji);
}

/**
 * Normalize a Telegram username: strip a leading @, trim, lowercase, and
 * validate the 1–32 char [A-Za-z0-9_] shape Telegram allows. Returns the
 * normalized handle (no @) or null when it is not a usable username.
 */
function normalizeUsername(value) {
  if (value == null) return null;
  const raw = String(value).trim().replace(/^@+/, '');
  if (!/^[A-Za-z0-9_]{1,32}$/.test(raw)) return null;
  return raw.toLowerCase();
}

/**
 * Coerce a Telegram user id to a canonical string, or null when absent/invalid.
 * Stringified so BIGINT ids keep full precision and map keys never collide with
 * numeric coercion surprises.
 */
function normalizeUserId(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  return /^\d+$/.test(raw) ? raw : null;
}

/**
 * Pick the reaction rule that applies to a message sender, preferring an exact
 * telegram_user_id match over a username match. `indexes` is
 * { byUserId: Map, byUsername: Map } of ENABLED rules keyed by the normalized
 * id / lowercase username. Returns the rule or null.
 */
function matchReactionRule(indexes, from) {
  if (!indexes || !from) return null;
  const id = normalizeUserId(from.id);
  if (id && indexes.byUserId.has(id)) return indexes.byUserId.get(id);
  const username = normalizeUsername(from.username);
  if (username && indexes.byUsername.has(username)) return indexes.byUsername.get(username);
  return null;
}

/**
 * Build fast lookup maps from a list of rule rows. Only enabled rules with a
 * valid emoji are indexed. A rule may carry an id, a username, or both.
 */
function buildReactionIndexes(rows) {
  const byUserId = new Map();
  const byUsername = new Map();
  for (const row of rows || []) {
    if (row.enabled === false) continue;
    if (!isAllowedReactionEmoji(row.emoji)) continue;
    const id = normalizeUserId(row.telegram_user_id);
    if (id) byUserId.set(id, row);
    const username = normalizeUsername(row.telegram_username);
    if (username) byUsername.set(username, row);
  }
  return { byUserId, byUsername };
}

module.exports = {
  ALLOWED_REACTION_EMOJIS,
  isAllowedReactionEmoji,
  normalizeUsername,
  normalizeUserId,
  matchReactionRule,
  buildReactionIndexes,
};
