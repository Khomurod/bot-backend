/**
 * Global Telegram user capture (`drivers` table): one row per user the bot
 * has ever seen, powering @-mentions and the survey answer flow.
 * Extracted verbatim from database/db.js; db.js re-exports these.
 */
const { query } = require('./pool');

async function upsertDriver(telegramUserId, username, firstName, lastName) {
  const res = await query(
    `INSERT INTO drivers (telegram_user_id, username, first_name, last_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_user_id)
     DO UPDATE SET username = EXCLUDED.username,
                   first_name = EXCLUDED.first_name,
                   last_name = EXCLUDED.last_name
     RETURNING *`,
    [telegramUserId, username, firstName, lastName]
  );
  return res.rows[0];
}

async function getDriverByTelegramId(telegramUserId) {
  const res = await query(
    'SELECT * FROM drivers WHERE telegram_user_id = $1',
    [telegramUserId]
  );
  return res.rows[0];
}

// Look up a captured user by username or (first/last) name so callers can build
// an inline mention for someone referenced only by name. Username matches win
// over name matches; ties break toward the most recently created row.
async function findDriverByName(name) {
  const cleaned = String(name || '').trim().replace(/^@+/, '');
  if (!cleaned) return undefined;
  const full = cleaned.replace(/\s+/g, ' ');
  const res = await query(
    `SELECT *,
            CASE
              WHEN LOWER(username) = LOWER($1) THEN 0
              WHEN LOWER(TRIM(CONCAT_WS(' ', first_name, last_name))) = LOWER($1) THEN 1
              WHEN LOWER(first_name) = LOWER($1) THEN 2
              ELSE 3
            END AS match_rank
       FROM drivers
      WHERE LOWER(username) = LOWER($1)
         OR LOWER(TRIM(CONCAT_WS(' ', first_name, last_name))) = LOWER($1)
         OR LOWER(first_name) = LOWER($1)
      ORDER BY match_rank ASC, created_at DESC
      LIMIT 1`,
    [full]
  );
  return res.rows[0];
}


module.exports = {
  upsertDriver,
  getDriverByTelegramId,
  findDriverByName,
};
