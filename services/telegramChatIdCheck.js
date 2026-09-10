/**
 * "Is this Telegram chat id one we can actually reach?" — the check that was
 * missing when a settings field accepted a chat id.
 *
 * Every chat-id setting was validated syntactically and no further, so
 * `5052301861` (the real chat is `-5052301861`, "HR Personnel") saved cleanly and
 * then failed forever at send time. The outbox behaved correctly — it retried,
 * backed off, exhausted its six attempts and recorded "chat not found" — but a
 * dead destination is not something a durable queue can fix, and nobody was told.
 *
 * The check is deliberately reluctant to say no. It rejects only when it can show
 * WHY: the value is not a chat id, its negation is a group we know (the dropped
 * minus sign), or the bot asked Telegram and was refused. When it cannot prove a
 * value wrong — no Telegram client to ask, no matching group — it accepts and says
 * it is unverified, because blocking a legitimate save is its own outage.
 */

const { GROUP_CHAT_TYPES, normalizeChatId, signFlipCandidate } = require('../lib/telegram/chatId');
const { cleanTelegramError } = require('../lib/telegram/telegramErrors');

function groupLabel(group, chatId) {
  return group?.group_name ? `"${group.group_name}"` : `chat ${chatId}`;
}

/**
 * @param {*} rawValue                 the id as typed
 * @param {object} deps
 * @param {Function} deps.getGroupByTelegramId  async (numericId) => group row | undefined
 * @param {object}  [deps.telegram]    Telegraf telegram client; omitted = no live probe
 * @returns {Promise<{ok:boolean, status:string, chatId:string|null,
 *   message?:string, suggestion?:string, groupName?:string|null}>}
 */
async function checkChatId(rawValue, { getGroupByTelegramId, telegram, allowPrivate = false } = {}) {
  const chatId = normalizeChatId(rawValue);
  if (chatId == null) {
    return {
      ok: false,
      status: 'invalid',
      chatId: null,
      message: 'must be a numeric Telegram chat id (a group id starts with "-", e.g. -1002997837889)',
    };
  }

  const lookup = typeof getGroupByTelegramId === 'function'
    ? getGroupByTelegramId
    : async () => undefined;

  // 1. Is this a chat we have a row for? That decides the sign-flip question
  //    below and, with no Telegram client, is the best answer available — but it
  //    is NOT proof of reachability. A `groups` row outlives the bot's access:
  //    `deactivateGroup` only flips `active`, so a chat the bot was removed from
  //    still has a row, and `bot_member_status = 'left'` on an ACTIVE group is
  //    common enough that Stage 2 has a check for it. Trusting a stale row here
  //    would let an admin save an unreachable destination and recreate exactly
  //    the silent-failure this check exists to prevent.
  const known = await lookup(chatId).catch(() => undefined);

  // 2. The dropped-minus case. Deliberately BEFORE the live probe: a positive id
  //    is a user id, and getChat will happily resolve one into a private chat —
  //    so probing first would accept the typo instead of catching it. Only asked
  //    when the id itself is unknown; a chat we hold a row for is not a typo.
  if (!known) {
    const flipped = signFlipCandidate(chatId);
    const flippedGroup = flipped ? await lookup(flipped).catch(() => undefined) : undefined;
    if (flippedGroup) {
      return {
        ok: false,
        status: 'sign_flipped',
        chatId,
        suggestion: flipped,
        groupName: flippedGroup.group_name || null,
        message: `does not match any known chat, but ${flipped} is ${groupLabel(flippedGroup, flipped)}. `
          + `Did you mean ${flipped}?`,
      };
    }
  }

  // 3. Ask Telegram, when there is a client to ask with — for a known group too.
  //    One getChat on an admin form submit is not a cost worth trading accuracy
  //    for; this is not a hot path.
  if (!telegram || typeof telegram.getChat !== 'function') {
    return known
      ? { ok: true, status: 'known_group', chatId, groupName: known.group_name || null }
      : { ok: true, status: 'unverified', chatId, groupName: null };
  }

  let chat;
  try {
    chat = await telegram.getChat(chatId);
  } catch (err) {
    return {
      ok: false,
      status: 'unreachable',
      chatId,
      message: `the bot cannot reach this chat: ${cleanTelegramError(err)}`,
    };
  }

  // A private chat is a PERSON. Opt-in per caller: AI monitoring may report to
  // one administrator, while the home-time destinations still address a room.
  // The sign-flip check above has already run, so a dropped minus sign cannot
  // hide behind this branch.
  if (allowPrivate && chat?.type === 'private') {
    const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ')
      || (chat.username ? `@${chat.username}` : null);
    return { ok: true, status: 'reachable_private', chatId, groupName: name };
  }

  if (!GROUP_CHAT_TYPES.has(chat?.type)) {
    return {
      ok: false,
      status: 'wrong_type',
      chatId,
      message: `this is a "${chat?.type || 'private'}" chat, not a group. `
        + 'Use a group, supergroup or channel the bot belongs to.',
    };
  }

  // Reachable AND on record is the strongest result; reachable alone still passes.
  return {
    ok: true,
    status: known ? 'known_group' : 'reachable',
    chatId,
    groupName: chat.title || known?.group_name || null,
  };
}

/**
 * Run checkChatId over several settings columns at once and return the first
 * failure as a ready-to-send 400 message naming the column.
 *
 * `patch` is the already-validated column patch: only keys PRESENT in it are
 * checked, and a null (the "clear this setting" value) is skipped, so clearing a
 * destination never has to satisfy a reachability check.
 */
async function checkChatIdColumns(patch, columns, deps = {}) {
  for (const column of columns) {
    const value = patch?.[column];
    if (value === undefined || value === null || value === '') continue;
    const result = await checkChatId(value, deps);
    if (!result.ok) return { error: `${column} ${result.message}`, column, result };
  }
  return { error: null };
}

module.exports = { checkChatId, checkChatIdColumns };
