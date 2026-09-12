/**
 * Who Wenze obeys in a notification group.
 *
 * BEING IN THE GROUP IS NOT AUTHORISATION. That sentence is the whole module.
 * A Telegram group contains whoever was ever added to it — dispatchers, a
 * second account, a bot, somebody who left the company but not the chat — and
 * without this list a reply from any of them would apply a correction to the
 * fleet. Telegram's own admin flags are not used as the gate either: being able
 * to pin a message in a chat is not the same as being allowed to change who is
 * assigned to a truck.
 *
 * Seeded by migration 0048 with the one id the application already trusts
 * (`CREATOR_USER_ID` in `bot/creatorMessageManager.js`), so the channel works
 * for its owner on the first boot and for nobody else.
 */
const { query } = require('./pool');

function mapOperator(row) {
  if (!row) return null;
  return {
    telegramUserId: String(row.telegram_user_id),
    label: row.label || null,
    adminId: row.admin_id == null ? null : Number(row.admin_id),
    enabled: row.enabled !== false,
    addedBy: row.added_by || null,
    createdAt: row.created_at || null,
  };
}

/**
 * Is this account allowed to steer Wenze?
 *
 * A MISSING TABLE ANSWERS NO. On a deploy where the migration has not yet run,
 * the safe answer to "may this stranger change the fleet" is no — this is the
 * one place in the repository where a degraded read must refuse rather than
 * fall back to a default.
 */
async function isControlOperator(telegramUserId) {
  if (telegramUserId == null) return false;
  try {
    const res = await query(
      'SELECT 1 FROM control_operators WHERE telegram_user_id = $1 AND enabled = TRUE',
      [String(telegramUserId)]
    );
    return res.rowCount > 0;
  } catch (_) {
    return false;
  }
}

async function listControlOperators() {
  try {
    const res = await query(
      'SELECT * FROM control_operators ORDER BY created_at ASC, telegram_user_id ASC'
    );
    return res.rows.map(mapOperator);
  } catch (_) {
    return [];
  }
}

async function countEnabledOperators() {
  const res = await query('SELECT COUNT(*)::int AS n FROM control_operators WHERE enabled = TRUE');
  return res.rows[0]?.n || 0;
}

async function addControlOperator({ telegramUserId, label = null, adminId = null, addedBy = null }) {
  const id = String(telegramUserId).trim();
  if (!/^-?\d+$/.test(id)) {
    const err = new Error('A Telegram user id is a number.');
    err.code = 'INVALID_TELEGRAM_USER_ID';
    throw err;
  }
  const res = await query(
    `INSERT INTO control_operators (telegram_user_id, label, admin_id, added_by, enabled)
     VALUES ($1,$2,$3,$4,TRUE)
     ON CONFLICT (telegram_user_id) DO UPDATE SET
       label = COALESCE(EXCLUDED.label, control_operators.label),
       admin_id = COALESCE(EXCLUDED.admin_id, control_operators.admin_id),
       enabled = TRUE
     RETURNING *`,
    [id, label, adminId == null ? null : Number(adminId), addedBy]
  );
  return mapOperator(res.rows[0]);
}

/**
 * Remove an operator.
 *
 * REFUSES TO REMOVE THE LAST ONE. An empty list does not mean "everybody" — it
 * means the channel answers nobody, and the only way back is the database. The
 * refusal is here rather than in the route so it holds for every caller.
 */
async function removeControlOperator(telegramUserId) {
  const id = String(telegramUserId).trim();
  const remaining = await query(
    'SELECT COUNT(*)::int AS n FROM control_operators WHERE enabled = TRUE AND telegram_user_id <> $1',
    [id]
  );
  if ((remaining.rows[0]?.n || 0) === 0) {
    const err = new Error('At least one operator must remain, or nobody can steer Wenze from Telegram.');
    err.code = 'LAST_OPERATOR';
    throw err;
  }
  const res = await query(
    'DELETE FROM control_operators WHERE telegram_user_id = $1 RETURNING *',
    [id]
  );
  return mapOperator(res.rows[0]);
}

module.exports = {
  isControlOperator,
  listControlOperators,
  countEnabledOperators,
  addControlOperator,
  removeControlOperator,
};
