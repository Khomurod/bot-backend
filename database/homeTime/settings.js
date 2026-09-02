/**
 * Home-Time settings rows — database helpers.
 *
 * Two single-row tables: the tracker's own settings (id = 1) and the super-admin
 * bot-access row. Split out of database/homeTime.js, which re-exports every
 * symbol here so existing importers are unchanged.
 */
const { query } = require('../pool');

// ─── Settings (single row, id = 1) ───

async function getHomeTimeSettings() {
  const res = await query('SELECT * FROM home_time_settings WHERE id = 1');
  return res.rows[0] || null;
}

const SETTINGS_COLUMNS = [
  'enabled', 'road_allowance_weeks', 'home_allowance_days', 'bonus_per_week',
  'reminder_first_hours', 'reminder_second_hours', 'completed_notify_group_id',
  // Silent mode: whether the bot may message DRIVER groups at all, and where the
  // internal "staff must clarify these dates" alert goes when it may not.
  'driver_clarification_enabled', 'internal_clarification_group_id',
];

async function updateHomeTimeSettings(patch = {}) {
  const sets = [];
  const values = [];
  let i = 1;
  for (const col of SETTINGS_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(patch, col)) {
      sets.push(`${col} = $${i}`);
      values.push(patch[col]);
      i += 1;
    }
  }
  if (!sets.length) return getHomeTimeSettings();
  sets.push('updated_at = NOW()');
  const res = await query(
    `UPDATE home_time_settings SET ${sets.join(', ')} WHERE id = 1 RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

// ─── Bot access settings (super admin) ───

async function getBotAccessSettings() {
  const res = await query('SELECT * FROM bot_access_settings WHERE id = 1');
  return res.rows[0] || null;
}

async function updateBotAccessSettings({ superAdminTelegramId, superAdminLabel }) {
  const res = await query(
    `UPDATE bot_access_settings
       SET super_admin_telegram_id = $1,
           super_admin_label = $2,
           updated_at = NOW()
     WHERE id = 1 RETURNING *`,
    [superAdminTelegramId == null ? null : String(superAdminTelegramId), superAdminLabel || null]
  );
  return res.rows[0] || null;
}

module.exports = {
  getHomeTimeSettings,
  updateHomeTimeSettings,
  getBotAccessSettings,
  updateBotAccessSettings,
};
