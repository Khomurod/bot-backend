/**
 * Telegram chat-id values — pure parsing, no I/O.
 *
 * A Telegram group id is NEGATIVE (a supergroup or channel is the `-100…` form).
 * The admin panel accepts these as free text, and a dropped minus sign yields an
 * id that is syntactically perfect and simply does not exist.
 *
 * Production ran that way for months: `home_time_settings` held `5052301861` for
 * a chat whose real id is `-5052301861`, so every internal home-time alert failed
 * with "chat not found", exhausted its six attempts, and died silently. Nothing in
 * the app ever said so. `signFlipCandidate` is the piece that makes exactly that
 * mistake detectable — it is the value a caller should look up to ask "did they
 * mean the negative of this?".
 *
 * Lives in lib/ because the routes, the settings services and the BOL/POD group
 * validator all need it, and none of it touches the network.
 */

/**
 * The chat types that are a GROUP a team reads, as opposed to a private chat
 * with one person. It matters wherever a setting names a destination: a positive
 * (user-shaped) id resolves through getChat perfectly happily, which is exactly
 * how a dropped minus sign can look like a working value.
 */
const GROUP_CHAT_TYPES = new Set(['group', 'supergroup', 'channel']);

/**
 * Canonical numeric chat id, or null when the value is not one at all.
 * Accepts an optional leading '-'; rejects '+', decimals, and anything over the
 * 20 digits a Telegram id can occupy.
 */
function normalizeChatId(raw) {
  const str = String(raw ?? '').trim();
  if (!/^-?\d{1,20}$/.test(str)) return null;
  // '-0' and '0' are not chat ids; normalizing them away keeps callers from
  // treating a stray zero as a configured destination.
  if (/^-?0+$/.test(str)) return null;
  return str;
}

/** True when the id has the negative sign a group/supergroup/channel id carries. */
function isGroupShapedChatId(raw) {
  const id = normalizeChatId(raw);
  return id != null && id.startsWith('-');
}

/**
 * The same id with its sign flipped, or null when the value is not a chat id.
 *
 * Returned for BOTH directions on purpose. A dropped minus is the common typo,
 * but an id that was pasted with one too many is the same class of mistake, and a
 * caller that can look up either answer catches both.
 */
function signFlipCandidate(raw) {
  const id = normalizeChatId(raw);
  if (id == null) return null;
  return id.startsWith('-') ? id.slice(1) : `-${id}`;
}

module.exports = { GROUP_CHAT_TYPES, normalizeChatId, isGroupShapedChatId, signFlipCandidate };
