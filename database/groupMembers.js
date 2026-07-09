/**
 * Group membership capture (users the bot has SEEN in each group) — powers
 * the admin "Driver Username" dropdown.
 * Extracted verbatim from database/db.js; db.js re-exports these.
 */
const { query } = require('./pool');
const { normalizeTelegramUserId } = require('./driverProfiles');

// ─── Group members (users the bot has SEEN in each group) ───
// The Bot API cannot enumerate a group's member list, so these rows are the
// only "membership" we have: every user an update touches is recorded here
// alongside the global `drivers` upsert. They power the admin "Driver
// Username" dropdown on the Driver Groups popup.

async function upsertGroupMember(groupId, user) {
  const telegramUserId = normalizeTelegramUserId(user?.id ?? user?.telegram_user_id);
  const gid = Number(groupId);
  if (!Number.isInteger(gid) || gid <= 0 || !telegramUserId) return null;
  const res = await query(
    `INSERT INTO group_members (group_id, telegram_user_id, username, first_name, last_name, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (group_id, telegram_user_id)
     DO UPDATE SET username = EXCLUDED.username,
                   first_name = EXCLUDED.first_name,
                   last_name = EXCLUDED.last_name,
                   last_seen_at = NOW()
     RETURNING *`,
    [gid, telegramUserId, user?.username || null, user?.first_name || null, user?.last_name || null]
  );
  return res.rows[0] || null;
}

// Drop the membership row when Telegram tells us the user left the group (the
// global `drivers` row is kept — their id is still useful for mentions).
async function removeGroupMember(groupId, telegramUserId) {
  const id = normalizeTelegramUserId(telegramUserId);
  const gid = Number(groupId);
  if (!Number.isInteger(gid) || gid <= 0 || !id) return;
  await query(
    'DELETE FROM group_members WHERE group_id = $1 AND telegram_user_id = $2',
    [gid, id]
  );
}

async function listGroupMembers(groupId) {
  const res = await query(
    `SELECT group_id, telegram_user_id, username, first_name, last_name, last_seen_at
     FROM group_members
     WHERE group_id = $1
     ORDER BY last_seen_at DESC, telegram_user_id ASC`,
    [Number(groupId)]
  );
  return res.rows;
}

module.exports = {
  upsertGroupMember,
  removeGroupMember,
  listGroupMembers,
};
