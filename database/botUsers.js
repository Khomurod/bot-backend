/**
 * Database helpers for bot_users — Telegram users who have actively interacted
 * with the bot's inline buttons (location check-in prompts etc.). Upserted on
 * every tap so the admin panel's Users tab always shows who pressed what last,
 * plus a running interaction count.
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

/** Users for the admin Users tab, most recently active first. */
async function listBotUsers(limit = 200) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 200;
  const res = await query(
    `SELECT u.*,
            (SELECT g.group_name FROM groups g WHERE g.id = u.last_group_id) AS last_group_name
     FROM bot_users u
     ORDER BY u.last_interaction_at DESC
     LIMIT $1`,
    [safeLimit]
  );
  return res.rows;
}

module.exports = {
  recordBotUserInteraction,
  listBotUsers,
};
