/**
 * Employee birthdays + wish settings.
 * Extracted verbatim from database/db.js; db.js re-exports these.
 */
const { query } = require('./pool');

async function upsertEmployeeBirthday(firstName, lastName, birthday) {
  const res = await query(
    `INSERT INTO employee_birthdays (first_name, last_name, birthday)
     VALUES ($1, $2, $3)
     ON CONFLICT (first_name, last_name) DO UPDATE SET birthday = EXCLUDED.birthday
     RETURNING *`,
    [firstName, lastName, birthday]
  );
  return res.rows[0];
}

async function getAllEmployeeBirthdays() {
  const res = await query('SELECT * FROM employee_birthdays ORDER BY created_at DESC');
  return res.rows;
}

async function getEmployeesWithBirthdayOn(month, day) {
  const res = await query(
    `SELECT * FROM employee_birthdays 
     WHERE EXTRACT(MONTH FROM birthday) = $1 AND EXTRACT(DAY FROM birthday) = $2
     ORDER BY last_name, first_name`,
    [month, day]
  );
  return res.rows;
}

async function getEmployeesWithBirthdayToday(month, day) {
  return getEmployeesWithBirthdayOn(month, day);
}

async function getEmployeeBirthdaysByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const res = await query(
    `SELECT * FROM employee_birthdays WHERE id = ANY($1::int[]) ORDER BY last_name, first_name`,
    [ids]
  );
  return res.rows;
}

const DEFAULT_EMPLOYEE_BIRTHDAY_AI_INSTRUCTIONS =
  'Write a warm, professional birthday message for office staff at Wenze. '
  + 'Be sincere and appreciative. Use different wording each time.';

const DEFAULT_EMPLOYEE_BIRTHDAY_FALLBACK =
  '🎉 <b>Happy Birthday!</b> 🎂\n\n'
  + 'Today we celebrate: <b>{names}</b>!\n\n'
  + 'Wishing you a fantastic day and a great year ahead!\n\n'
  + '— <i>Wenze Management</i>';

async function ensureEmployeeBirthdaySettings() {
  const existing = await query('SELECT id FROM employee_birthday_settings WHERE id = 1');
  if (existing.rows.length > 0) return;

  const tz = process.env.EMPLOYEE_BIRTHDAY_TZ || 'Asia/Tashkent';
  const hour = Math.min(23, Math.max(0, parseInt(process.env.EMPLOYEE_BIRTHDAY_HOUR || '0', 10) || 0));
  const minute = Math.min(59, Math.max(0, parseInt(process.env.EMPLOYEE_BIRTHDAY_MINUTE || '0', 10) || 0));

  await query(
    `INSERT INTO employee_birthday_settings (
       id, timezone, send_hour, send_minute, ai_instructions, fallback_template
     ) VALUES (1, $1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
  [
    tz,
    hour,
    minute,
    DEFAULT_EMPLOYEE_BIRTHDAY_AI_INSTRUCTIONS,
    DEFAULT_EMPLOYEE_BIRTHDAY_FALLBACK,
  ]
  );
}

async function getEmployeeBirthdaySettings() {
  await ensureEmployeeBirthdaySettings();
  const res = await query('SELECT * FROM employee_birthday_settings WHERE id = 1');
  return res.rows[0];
}

async function updateEmployeeBirthdaySettings({
  timezone,
  sendHour,
  sendMinute,
  aiInstructions,
  fallbackTemplate,
}) {
  await ensureEmployeeBirthdaySettings();
  const res = await query(
    `UPDATE employee_birthday_settings
     SET timezone = $1,
         send_hour = $2,
         send_minute = $3,
         ai_instructions = $4,
         fallback_template = $5,
         updated_at = NOW()
     WHERE id = 1
     RETURNING *`,
    [timezone, sendHour, sendMinute, aiInstructions, fallbackTemplate]
  );
  return res.rows[0];
}

async function updateEmployeeBirthday(id, firstName, lastName, birthday) {
  const res = await query(
    `UPDATE employee_birthdays 
     SET first_name = $1, last_name = $2, birthday = $3 
     WHERE id = $4 RETURNING *`,
    [firstName, lastName, birthday, id]
  );
  return res.rows[0];
}

async function deleteEmployeeBirthday(id) {
  await query('DELETE FROM employee_birthdays WHERE id = $1', [id]);
}


module.exports = {
  upsertEmployeeBirthday,
  getAllEmployeeBirthdays,
  getEmployeesWithBirthdayOn,
  getEmployeesWithBirthdayToday,
  getEmployeeBirthdaysByIds,
  ensureEmployeeBirthdaySettings,
  getEmployeeBirthdaySettings,
  updateEmployeeBirthdaySettings,
  updateEmployeeBirthday,
  deleteEmployeeBirthday,
};
