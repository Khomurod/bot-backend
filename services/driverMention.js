/**
 * Driver mention resolver — Route Control.
 *
 * Works out how to address the driver of a driver group in a Telegram message,
 * preferring the most reliable identity we hold:
 *
 *   1. Telegram user ID  → HTML mention `<a href="tg://user?id=…">Name</a>`
 *      (stable; notifies the exact person even with no username).
 *   2. Telegram username → `@username`.
 *   3. Neither           → the driver's plain (HTML-escaped) name.
 *
 * Identity comes ONLY from the group's own Driver Profile (driver_profiles),
 * never from ambient group chatter — so a dispatcher who happens to text in the
 * group can never be tagged as the driver. When no driver Telegram account is
 * known we fall back to the plain name and never fail.
 *
 * buildDriverMention is PURE (no DB) and unit-tested; resolveDriverMentionForGroup
 * is the thin DB-backed wrapper.
 */
const { normalizeTelegramUsername } = require('../lib/telegram/telegramUsername');

/** Minimal HTML escape for Telegram HTML parse_mode (& < > only). */
function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** A Telegram user id is a positive integer; accept number or numeric string. */
function normalizeTelegramUserId(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!/^[1-9]\d*$/.test(s)) return null;
  return s;
}

/**
 * Build a driver mention from already-resolved identity fields. Pure.
 *
 * @param {{ telegramUserId?:(string|number|null), username?:(string|null),
 *           displayName?:(string|null), groupName?:(string|null),
 *           nameSource?:(string|null) }} input
 * @returns {{ mentionHtml:string, displayName:string,
 *             telegramUserId:(string|null), username:(string|null),
 *             source:string, confidence:('high'|'medium'|'low') }}
 */
function buildDriverMention({
  telegramUserId = null, username = null, displayName = null, groupName = null, nameSource = null,
} = {}) {
  const rawName = (displayName && String(displayName).trim())
    || (groupName && String(groupName).trim())
    || 'driver';
  const safeName = escapeHtml(rawName);

  const id = normalizeTelegramUserId(telegramUserId);
  if (id) {
    return {
      mentionHtml: `<a href="tg://user?id=${id}">${safeName}</a>`,
      displayName: rawName,
      telegramUserId: id,
      username: normalizeTelegramUsername(username),
      source: 'telegram_user_id',
      confidence: 'high',
    };
  }

  const uname = normalizeTelegramUsername(username);
  if (uname) {
    return {
      mentionHtml: `@${uname}`,
      displayName: rawName,
      telegramUserId: null,
      username: uname,
      source: 'telegram_username',
      confidence: 'medium',
    };
  }

  return {
    mentionHtml: safeName,
    displayName: rawName,
    telegramUserId: null,
    username: null,
    source: nameSource || 'name',
    confidence: 'low',
  };
}

/**
 * Resolve the driver mention for a driver group by loading its Driver Profile.
 * Never throws for a missing profile / driver Telegram account — falls back to
 * the group name.
 *
 * @param {number} groupId
 * @param {{ db?:object }} [deps]  injectable DB module for testing
 */
async function resolveDriverMentionForGroup(groupId, { db = require('../database/db') } = {}) {
  let profile = null;
  try {
    profile = await db.getDriverProfileByGroupId(groupId);
  } catch (_) {
    profile = null; // fall through to a group-name-only mention
  }

  if (profile) {
    const displayName = (profile.full_name && String(profile.full_name).trim())
      || [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim()
      || null;
    return buildDriverMention({
      telegramUserId: profile.telegram_user_id,
      username: profile.telegram_username,
      displayName,
      groupName: profile.group_name,
      nameSource: displayName ? 'driver_profile' : 'group_title',
    });
  }

  // No profile row — best-effort group name for a plain mention.
  let groupName = null;
  try {
    const group = db.getGroupByIdAnyType ? await db.getGroupByIdAnyType(groupId) : null;
    groupName = group?.group_name || null;
  } catch (_) { /* ignore */ }
  return buildDriverMention({ groupName, nameSource: 'group_title' });
}

module.exports = {
  escapeHtml,
  normalizeTelegramUserId,
  buildDriverMention,
  resolveDriverMentionForGroup,
};
