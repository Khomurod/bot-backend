/**
 * telegramMention — build Telegram "@-tag" mentions that also work for users
 * who have NO public @username.
 *
 * Telegram lets you ping a user two ways:
 *   1. `@username`                       — only if the user set a public username.
 *   2. an *inline mention* via an HTML   — works for ANYONE, username or not:
 *      anchor to `tg://user?id=<ID>`:        `<a href="tg://user?id=123">Name</a>`
 *
 * The inline form requires `parse_mode: 'HTML'` on the send call, and — this is
 * the important operational constraint — it only reliably *notifies* a user the
 * bot has already "seen" (shared a group with / been interacted with). That is
 * why we capture every user's numeric id broadly in bot/bot.js: without the id
 * on file we can never build the fallback, and without having seen the user the
 * ping may render as plain text with no notification.
 *
 * This module is pure (buildMention et al. do no I/O) so it is unit-testable.
 * The DB-backed resolver is a thin wrapper that looks the id/name up and then
 * defers to the pure builder.
 */

/**
 * Escape the five characters that matter for Telegram's HTML parse_mode.
 * Telegram only supports a small tag subset, so `&`, `<`, `>` are the ones
 * that break parsing; we also escape quotes defensively for attribute safety.
 */
function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Strip a single leading "@" and surrounding whitespace from a username. */
function normalizeUsername(username) {
  const u = String(username == null ? '' : username).trim().replace(/^@+/, '');
  return u || null;
}

/**
 * Telegram numeric user ids are positive integers. Accept a number or a numeric
 * string (ids can exceed 2^53, so we never coerce through Number for storage);
 * return the canonical digit string, or null if it is not a valid id.
 */
function normalizeUserId(id) {
  if (id == null) return null;
  const s = String(id).trim();
  return /^[1-9]\d*$/.test(s) ? s : null;
}

/**
 * Best-effort human display name from the stored fields.
 * Prefers first+last, then username, then a generic fallback.
 */
function buildDisplayName(user, fallback = 'there') {
  if (!user || typeof user !== 'object') return fallback;
  const name = [user.first_name, user.last_name]
    .map((p) => String(p == null ? '' : p).trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  if (name) return name;
  const username = normalizeUsername(user.username);
  if (username) return username;
  return fallback;
}

/**
 * Build the best available mention string for a user.
 *
 * @param {object} user  { username?, telegram_user_id?|id?, first_name?, last_name? }
 * @param {object} [opts]
 * @param {string} [opts.fallbackName]  display name to use for the inline anchor
 *                                       / plain fallback when the record has none.
 * @returns {string} `@username` when a username exists, otherwise an HTML inline
 *   mention `<a href="tg://user?id=ID">Name</a>`, otherwise the escaped display
 *   name as plain text (no reliable ping, but never broken markup).
 */
function buildMention(user, opts = {}) {
  const u = user && typeof user === 'object' ? user : {};
  const username = normalizeUsername(u.username);
  if (username) return `@${username}`;

  const fallbackName = opts.fallbackName != null && String(opts.fallbackName).trim()
    ? String(opts.fallbackName).trim()
    : null;
  const display = fallbackName || buildDisplayName(u);

  const id = normalizeUserId(u.telegram_user_id != null ? u.telegram_user_id : u.id);
  if (id) {
    return `<a href="tg://user?id=${id}">${escapeHtml(display)}</a>`;
  }
  // No username and no numeric id → best we can do is the escaped name. This
  // will not notify anyone, but it keeps the message well-formed.
  return escapeHtml(display);
}

/**
 * Create a DB-backed resolver. `db` only needs the two lookup methods used
 * below, which keeps it trivially mockable in unit tests.
 *
 * @param {object} db  e.g. require('../database/db')
 */
function createMentionResolver(db) {
  /**
   * Resolve a mention from a numeric telegram user id. Looks up the stored
   * driver (for a possibly-newer username / real name); if the row is missing
   * we can still build an inline mention straight from the id.
   */
  async function mentionForTelegramId(telegramUserId, opts = {}) {
    const id = normalizeUserId(telegramUserId);
    if (!id) {
      // Nothing to ping — fall back to a plain escaped label if one was given.
      return opts.fallbackName ? escapeHtml(String(opts.fallbackName)) : '';
    }
    let row = null;
    try {
      row = db && typeof db.getDriverByTelegramId === 'function'
        ? await db.getDriverByTelegramId(id)
        : null;
    } catch (_err) {
      row = null;
    }
    return buildMention(row || { telegram_user_id: id }, opts);
  }

  /**
   * Resolve a mention from a name (username or first/last). Returns a real
   * ping when we have the user on file, else the escaped name as plain text.
   */
  async function mentionForName(name, opts = {}) {
    const cleaned = normalizeUsername(name) || String(name == null ? '' : name).trim();
    if (!cleaned) return '';
    let row = null;
    try {
      row = db && typeof db.findDriverByName === 'function'
        ? await db.findDriverByName(cleaned)
        : null;
    } catch (_err) {
      row = null;
    }
    if (row) return buildMention(row, opts);
    return buildMention({}, { fallbackName: opts.fallbackName || cleaned });
  }

  return { mentionForTelegramId, mentionForName };
}

module.exports = {
  buildMention,
  buildDisplayName,
  createMentionResolver,
  escapeHtml,
  normalizeUsername,
  normalizeUserId,
};
