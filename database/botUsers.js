/**
 * Database helpers for bot_users — Telegram users the bot has seen, keyed by a
 * stable telegram_user_id.
 *
 * Two capture paths feed the same row (never duplicated):
 *   - recordBotUserInteraction — an inline-button tap (bumps `interactions`).
 *   - recordBotUserSeen        — any message from a human in a group the bot is
 *     in (bumps `message_count`, refreshes last-seen group / chat).
 *
 * COALESCE(EXCLUDED…, existing) means a username / name / language change
 * updates the SAME telegram_user_id row rather than creating a new one. NO
 * message text is ever stored — only identity + counters + last-seen metadata.
 */
const { query } = require('./db');

/**
 * Record one button interaction. Inserts the user on first tap; afterwards
 * refreshes their username/name (people rename themselves), bumps the counter
 * and stamps the last action. Never throws data at callers' feet: username and
 * names are optional (Telegram users may have neither).
 */
async function recordBotUserInteraction({
  telegramUserId,
  username = null,
  firstName = null,
  lastName = null,
  action = null,
  groupId = null,
}) {
  if (telegramUserId == null) return null;
  const res = await query(
    `INSERT INTO bot_users
       (telegram_user_id, username, first_name, last_name, interactions, last_action, last_group_id, first_seen_at, last_interaction_at)
     VALUES ($1, $2, $3, $4, 1, $5, $6, NOW(), NOW())
     ON CONFLICT (telegram_user_id)
     DO UPDATE SET username = COALESCE(EXCLUDED.username, bot_users.username),
                   first_name = COALESCE(EXCLUDED.first_name, bot_users.first_name),
                   last_name = COALESCE(EXCLUDED.last_name, bot_users.last_name),
                   interactions = bot_users.interactions + 1,
                   last_action = COALESCE(EXCLUDED.last_action, bot_users.last_action),
                   last_group_id = COALESCE(EXCLUDED.last_group_id, bot_users.last_group_id),
                   last_interaction_at = NOW()
     RETURNING *`,
    [
      Number(telegramUserId),
      username ? String(username).slice(0, 64) : null,
      firstName ? String(firstName).slice(0, 128) : null,
      lastName ? String(lastName).slice(0, 128) : null,
      action ? String(action).slice(0, 64) : null,
      groupId != null ? Number(groupId) : null,
    ]
  );
  return res.rows[0] || null;
}

/**
 * Record that a user was SEEN texting (any message type) in a group. Inserts on
 * first sighting; afterwards increments `message_count`, refreshes
 * username/first/last/language, updates last-seen group/chat, and bumps
 * last_interaction_at. Uses COALESCE(EXCLUDED…, existing) so identity changes
 * update the same row and never duplicate. Stores NO message text.
 */
async function recordBotUserSeen({
  telegramUserId,
  username = null,
  firstName = null,
  lastName = null,
  languageCode = null,
  isBot = false,
  groupId = null,
  chatId = null,
  groupName = null,
}) {
  if (telegramUserId == null) return null;
  const res = await query(
    `INSERT INTO bot_users
       (telegram_user_id, username, first_name, last_name, language_code, is_bot,
        message_count, last_group_id, last_seen_chat_id, last_group_name,
        first_seen_at, last_interaction_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, NOW(), NOW())
     ON CONFLICT (telegram_user_id)
     DO UPDATE SET username = COALESCE(EXCLUDED.username, bot_users.username),
                   first_name = COALESCE(EXCLUDED.first_name, bot_users.first_name),
                   last_name = COALESCE(EXCLUDED.last_name, bot_users.last_name),
                   language_code = COALESCE(EXCLUDED.language_code, bot_users.language_code),
                   is_bot = COALESCE(EXCLUDED.is_bot, bot_users.is_bot),
                   message_count = bot_users.message_count + 1,
                   last_group_id = COALESCE(EXCLUDED.last_group_id, bot_users.last_group_id),
                   last_seen_chat_id = COALESCE(EXCLUDED.last_seen_chat_id, bot_users.last_seen_chat_id),
                   last_group_name = COALESCE(EXCLUDED.last_group_name, bot_users.last_group_name),
                   last_interaction_at = NOW()
     RETURNING *`,
    [
      Number(telegramUserId),
      username ? String(username).slice(0, 64) : null,
      firstName ? String(firstName).slice(0, 128) : null,
      lastName ? String(lastName).slice(0, 128) : null,
      languageCode ? String(languageCode).slice(0, 16) : null,
      isBot === true,
      groupId != null ? Number(groupId) : null,
      chatId != null ? Number(chatId) : null,
      groupName ? String(groupName).slice(0, 256) : null,
    ]
  );
  return res.rows[0] || null;
}

// Accepted coarse filters for the admin Users tab.
const FILTERS = new Set(['all', 'admins', 'dispatch', 'drivers', 'unknown', 'recent']);

/**
 * Users for the admin Users tab. LEFT JOINs dispatch_team_members on either a
 * case-insensitive username match OR a telegram_user_id match to expose the
 * linked dispatch team; source='dispatcher' is inferred when matched. Supports
 * coarse filters and a free-text search.
 *
 * @param {{ limit?:number, filter?:string, search?:string }} opts
 */
async function listBotUsers({ limit = 200, filter = 'all', search = '' } = {}) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 200;
  const f = FILTERS.has(String(filter)) ? String(filter) : 'all';
  const params = [];
  const where = [];

  if (f === 'dispatch') {
    where.push('dm.id IS NOT NULL');
  } else if (f === 'drivers') {
    where.push("dm.id IS NULL AND (u.source = 'driver' OR u.source IS NULL)");
  } else if (f === 'admins') {
    where.push("u.source = 'admin'");
  } else if (f === 'unknown') {
    where.push("dm.id IS NULL AND (u.source = 'unknown' OR u.source IS NULL)");
  } else if (f === 'recent') {
    where.push("u.last_interaction_at >= NOW() - INTERVAL '24 hours'");
  }

  const q = String(search || '').trim();
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    const idx = params.length;
    where.push(
      `(LOWER(COALESCE(u.username, '')) LIKE $${idx}
        OR LOWER(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) LIKE $${idx}
        OR CAST(u.telegram_user_id AS TEXT) LIKE $${idx}
        OR LOWER(COALESCE(u.last_group_name, '')) LIKE $${idx})`
    );
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(safeLimit);
  const limitIdx = params.length;

  const res = await query(
    `SELECT u.*,
            COALESCE(u.last_group_name,
                     (SELECT g.group_name FROM groups g WHERE g.id = u.last_group_id)) AS last_group_name,
            dm.team_id AS linked_team_id,
            dt.name AS linked_team_name
     FROM bot_users u
     LEFT JOIN LATERAL (
       SELECT m.team_id, m.id
       FROM dispatch_team_members m
       WHERE m.active = TRUE
         AND (
           (m.telegram_username IS NOT NULL AND u.username IS NOT NULL
             AND LOWER(m.telegram_username) = LOWER(u.username))
           OR (m.telegram_user_id IS NOT NULL AND m.telegram_user_id = u.telegram_user_id)
         )
       LIMIT 1
     ) dm ON TRUE
     LEFT JOIN dispatch_teams dt ON dt.id = dm.team_id
     ${whereSql}
     ORDER BY u.last_interaction_at DESC
     LIMIT $${limitIdx}`,
    params
  );
  return res.rows;
}

/**
 * Opportunistically backfill dispatch_team_members.telegram_user_id when a
 * member row has a matching username but a NULL id. Safe: only fills nulls and
 * matches on a case-insensitive username. Best-effort; callers ignore failure.
 * @returns {Promise<number>} rows updated
 */
async function backfillDispatchMemberUserId({ telegramUserId, username }) {
  if (telegramUserId == null || !username) return 0;
  const res = await query(
    `UPDATE dispatch_team_members
        SET telegram_user_id = $1, updated_at = NOW()
      WHERE telegram_user_id IS NULL
        AND telegram_username IS NOT NULL
        AND LOWER(telegram_username) = LOWER($2)`,
    [Number(telegramUserId), String(username)]
  );
  return res.rowCount || 0;
}

module.exports = {
  recordBotUserInteraction,
  recordBotUserSeen,
  listBotUsers,
  backfillDispatchMemberUserId,
};
