'use strict';

/**
 * Company employees: the staff list (`employee_birthdays`) with the American
 * name, the Telegram account and the photo the birthday card needs.
 * Migration 0084; see docs/architecture/employee-birthday-cards.md.
 *
 * THE PHOTO IS READ ONE AT A TIME. The list carries only `has_photo`, so the
 * admin table and the birthday pass never pull every photo's bytes.
 *
 * A SUGGESTION NEVER OVERWRITES A PERSON. `applyTelegramSuggestions` writes
 * only rows with no account, or with an earlier suggestion; an account typed
 * or confirmed in the admin (`telegram_match = 'confirmed'`) is left alone.
 */
const { query } = require('./pool');

const LIST_COLUMNS = `e.id, e.first_name, e.last_name, e.birthday, e.american_name,
  e.telegram_username, e.telegram_user_id, e.telegram_match, e.created_at, e.updated_at,
  EXISTS (SELECT 1 FROM employee_photos p WHERE p.employee_id = e.id) AS has_photo`;

function mapEmployee(row) {
  if (!row) return null;
  return {
    ...row,
    telegram_user_id: row.telegram_user_id == null ? null : String(row.telegram_user_id),
    has_photo: row.has_photo === true,
  };
}

async function listCompanyEmployees() {
  const res = await query(
    `SELECT ${LIST_COLUMNS} FROM employee_birthdays e ORDER BY e.last_name, e.first_name, e.id`
  );
  return res.rows.map(mapEmployee);
}

async function getCompanyEmployee(id) {
  const res = await query(`SELECT ${LIST_COLUMNS} FROM employee_birthdays e WHERE e.id = $1`, [id]);
  return mapEmployee(res.rows[0]);
}

/**
 * The American name and the Telegram account, as a person typed them. An
 * account saved here is `confirmed`; clearing both clears the match too.
 * @returns {Promise<object|null>} the row, or null when there is no such employee
 */
async function updateCompanyEmployee(id, { americanName, telegramUsername, telegramUserId }) {
  const hasAccount = Boolean(telegramUsername || telegramUserId);
  const res = await query(
    `UPDATE employee_birthdays
        SET american_name = $2, telegram_username = $3, telegram_user_id = $4,
            telegram_match = $5, updated_at = NOW()
      WHERE id = $1
      RETURNING id`,
    [id, americanName || null, telegramUsername || null, telegramUserId || null,
      hasAccount ? 'confirmed' : null]
  );
  return res.rows[0] ? getCompanyEmployee(id) : null;
}

/** A suggested account checked by a person: `suggested` → `confirmed`, nothing else changes. */
async function confirmTelegramMatch(id) {
  const res = await query(
    `UPDATE employee_birthdays SET telegram_match = 'confirmed', updated_at = NOW()
      WHERE id = $1 AND telegram_match = 'suggested' RETURNING id`,
    [id]
  );
  return res.rows[0] ? getCompanyEmployee(id) : null;
}

/**
 * The Telegram accounts the bot has seen, newest name first — the field the
 * suggestion pass matches against. Bots are left out.
 */
async function listKnownTelegramAccounts() {
  const res = await query(
    `SELECT DISTINCT ON (telegram_user_id) telegram_user_id, username, first_name, last_name
       FROM (
         SELECT telegram_user_id, username, first_name, last_name, last_interaction_at AS seen_at
           FROM bot_users WHERE COALESCE(is_bot, FALSE) = FALSE
         UNION ALL
         SELECT telegram_user_id, username, first_name, last_name, last_seen_at AS seen_at
           FROM group_members
       ) seen
      WHERE telegram_user_id IS NOT NULL
      ORDER BY telegram_user_id, seen_at DESC NULLS LAST`
  );
  return res.rows;
}

/**
 * Store suggestions. Only a row with no account, or an earlier suggestion, is
 * written; a confirmed account is never touched.
 * @param {Array<{employeeId:number, telegramUserId:string, username:string|null}>} suggestions
 * @returns {Promise<number>} rows written
 */
async function applyTelegramSuggestions(suggestions) {
  let written = 0;
  for (const s of suggestions) {
    const res = await query(
      `UPDATE employee_birthdays
          SET telegram_username = $2, telegram_user_id = $3, telegram_match = 'suggested',
              updated_at = NOW()
        WHERE id = $1
          AND (telegram_match = 'suggested'
               OR (telegram_match IS NULL AND telegram_username IS NULL AND telegram_user_id IS NULL))`,
      [s.employeeId, s.username ? String(s.username).toLowerCase() : null, s.telegramUserId]
    );
    written += res.rowCount || 0;
  }
  return written;
}

async function savePhoto(id, image, mime = 'image/jpeg') {
  await query(
    `INSERT INTO employee_photos (employee_id, image, mime, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (employee_id) DO UPDATE
       SET image = EXCLUDED.image, mime = EXCLUDED.mime, updated_at = NOW()`,
    [id, image, mime]
  );
}

/** @returns {Promise<Buffer|null>} */
async function getPhoto(id) {
  const res = await query('SELECT image FROM employee_photos WHERE employee_id = $1', [id]);
  return res.rows[0] ? res.rows[0].image : null;
}

/** @returns {Promise<boolean>} whether there was one */
async function deletePhoto(id) {
  const res = await query('DELETE FROM employee_photos WHERE employee_id = $1', [id]);
  return (res.rowCount || 0) > 0;
}

module.exports = {
  listCompanyEmployees,
  getCompanyEmployee,
  updateCompanyEmployee,
  confirmTelegramMatch,
  listKnownTelegramAccounts,
  applyTelegramSuggestions,
  savePhoto,
  getPhoto,
  deletePhoto,
};
