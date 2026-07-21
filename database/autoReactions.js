/**
 * Database helpers for auto_reaction_rules — "when this user posts, react with
 * this emoji". A rule targets a stable telegram_user_id and/or a
 * telegram_username (at least one). Re-adding the same identity UPDATES the
 * existing rule (its emoji / enabled state) instead of duplicating it, matching
 * the partial-unique indexes in schema.sql.
 */
const { query } = require('./db');

/** Every rule, newest first, for the admin list. */
async function listAutoReactionRules() {
  const res = await query('SELECT * FROM auto_reaction_rules ORDER BY created_at DESC, id DESC');
  return res.rows;
}

/** Every ENABLED rule — the working set the bot loads into memory. */
async function listEnabledAutoReactionRules() {
  const res = await query('SELECT * FROM auto_reaction_rules WHERE enabled = TRUE');
  return res.rows;
}

async function getAutoReactionRuleById(id) {
  const res = await query('SELECT * FROM auto_reaction_rules WHERE id = $1', [id]);
  return res.rows[0] || null;
}

/**
 * Create or update a rule for a target identity. Callers pass an already
 * normalized emoji, a numeric-string/bigint telegramUserId and/or a lowercase
 * telegramUsername (no @). The matching partial-unique index resolves the
 * upsert: id-bearing rules key on telegram_user_id, username-only rules key on
 * LOWER(telegram_username). Returns the stored row.
 */
async function upsertAutoReactionRule({
  telegramUserId = null, telegramUsername = null, emoji, enabled = true, note = null, createdBy = null,
}) {
  const uid = telegramUserId != null && String(telegramUserId).trim() !== '' ? String(telegramUserId) : null;
  const uname = telegramUsername ? String(telegramUsername) : null;
  // Adding a user by id who already has a username-only (or a stale same-username)
  // rule would otherwise hit the username unique index. Fold those into the id
  // rule: drop any OTHER rule that carries this username first. Telegram usernames
  // are unique at any moment, so a leftover same-username rule is the same person.
  if (uid && uname) {
    await query(
      'DELETE FROM auto_reaction_rules WHERE LOWER(telegram_username) = LOWER($1) AND telegram_user_id IS DISTINCT FROM $2',
      [uname, uid]
    );
  }
  const conflict = uid
    ? '(telegram_user_id) WHERE telegram_user_id IS NOT NULL'
    : '(LOWER(telegram_username)) WHERE telegram_username IS NOT NULL';
  const res = await query(
    `INSERT INTO auto_reaction_rules
       (telegram_user_id, telegram_username, emoji, enabled, note, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT ${conflict}
     DO UPDATE SET
       emoji = EXCLUDED.emoji,
       enabled = EXCLUDED.enabled,
       note = COALESCE(EXCLUDED.note, auto_reaction_rules.note),
       telegram_user_id = COALESCE(EXCLUDED.telegram_user_id, auto_reaction_rules.telegram_user_id),
       telegram_username = COALESCE(EXCLUDED.telegram_username, auto_reaction_rules.telegram_username),
       updated_at = NOW()
     RETURNING *`,
    [uid, uname, emoji, enabled !== false, note, createdBy]
  );
  return res.rows[0];
}

/** Update a rule's emoji and/or enabled flag by id. Returns the row or null. */
async function updateAutoReactionRule(id, { emoji, enabled } = {}) {
  const sets = [];
  const values = [id];
  let i = 2;
  if (emoji !== undefined) { sets.push(`emoji = $${i}`); values.push(emoji); i += 1; }
  if (enabled !== undefined) { sets.push(`enabled = $${i}`); values.push(Boolean(enabled)); i += 1; }
  if (!sets.length) return getAutoReactionRuleById(id);
  sets.push('updated_at = NOW()');
  const res = await query(
    `UPDATE auto_reaction_rules SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

async function deleteAutoReactionRule(id) {
  const res = await query('DELETE FROM auto_reaction_rules WHERE id = $1 RETURNING id', [id]);
  return res.rows.length > 0;
}

module.exports = {
  listAutoReactionRules,
  listEnabledAutoReactionRules,
  getAutoReactionRuleById,
  upsertAutoReactionRule,
  updateAutoReactionRule,
  deleteAutoReactionRule,
};
