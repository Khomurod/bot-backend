/**
 * Driver Raise settings row — database helpers.
 *
 * The single settings row (id = 1) holding the weekly schedule, link TTL and the
 * encrypted Gmail App Password. `next_run_at` written here is what the raise
 * scheduler sleeps until, so a change must re-arm it — services/raiseApprovalService
 * does that in recomputeNextRun(). Split out of database/raiseApproval.js, which
 * re-exports every symbol here.
 */
const { query } = require('../pool');

// ─── Settings (single row, id = 1) ───

async function getRaiseSettings() {
  const res = await query('SELECT * FROM raise_settings WHERE id = 1');
  return res.rows[0] || null;
}

const SETTINGS_COLUMNS = [
  'enabled', 'otp_channel', 'schedule_enabled', 'weekly_day_of_week',
  'weekly_time_local', 'schedule_timezone', 'rate_low', 'rate_high',
  'link_ttl_hours', 'next_run_at', 'gmail_user', 'gmail_app_password_encrypted',
];

async function updateRaiseSettings(patch = {}) {
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
  if (!sets.length) return getRaiseSettings();
  sets.push('updated_at = NOW()');
  const res = await query(
    `UPDATE raise_settings SET ${sets.join(', ')} WHERE id = 1 RETURNING *`,
    values
  );
  return res.rows[0] || null;
}

module.exports = {
  getRaiseSettings,
  updateRaiseSettings,
};
