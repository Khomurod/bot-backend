/**
 * Trailer Tracking settings — one row (id = 1), with defaults for a fresh
 * install so callers never have to cope with a missing record.
 */

const { query } = require('../pool');
const { boundedText: s } = require('../sqlValues');

async function getTrailerSettings() {
  const res = await query('SELECT * FROM trailer_settings WHERE id = 1');
  return res.rows[0] || {
    id: 1, enabled: true, beta_mode: true, automatic_update_test_group_id: null,
    send_driver_group_confirmation: true, send_reaction: true,
    ai_fallback_enabled: true, geocoding_enabled: true,
    semantic_ai_required: true, auto_register_confidence: 92, review_confidence: 75,
    silent_driver_group_monitoring: true,
  };
}

async function updateTrailerSettings(patch = {}) {
  const allowed = {
    enabled: (v) => Boolean(v),
    beta_mode: (v) => Boolean(v),
    automatic_update_test_group_id: (v) => s(v, 40),
    send_driver_group_confirmation: (v) => Boolean(v),
    send_reaction: (v) => Boolean(v),
    ai_fallback_enabled: (v) => Boolean(v),
    geocoding_enabled: (v) => Boolean(v),
    semantic_ai_required: (v) => Boolean(v),
    auto_register_confidence: (v) => Math.max(50, Math.min(100, Math.round(Number(v)) || 92)),
    review_confidence: (v) => Math.max(0, Math.min(100, Math.round(Number(v)) || 75)),
    silent_driver_group_monitoring: (v) => Boolean(v),
    payment_confirmation_group_id: (v) => s(v, 40), overdue_reminder_group_id: (v) => s(v, 40),
    responsible_telegram_username: (v) => s(String(v || '').replace(/^@/, ''), 64), responsible_telegram_user_id: (v) => s(v, 40),
    escalation_telegram_username: (v) => s(String(v || '').replace(/^@/, ''), 64), escalation_telegram_user_id: (v) => s(v, 40),
    reminder_timezone: (v) => s(v, 80) || 'America/Chicago', payment_grace_period_days: (v) => Math.max(0, Math.min(90, Math.round(Number(v)) || 0)),
    reminder_hour: (v) => Math.max(0, Math.min(23, Math.round(Number(v)) || 0)), reminder_repeat_days: (v) => Math.max(1, Math.min(30, Math.round(Number(v)) || 1)),
    reminder_escalation_days: (v) => Math.max(1, Math.min(90, Math.round(Number(v)) || 7)), reminder_weekend_behavior: (v) => v === 'send' ? 'send' : 'skip',
    reminders_enabled: (v) => Boolean(v),
  };
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, fn] of Object.entries(allowed)) {
    if (patch[k] !== undefined) { sets.push(`${k} = $${i++}`); vals.push(fn(patch[k])); }
  }
  if (!sets.length) return getTrailerSettings();
  sets.push('updated_at = NOW()');
  const res = await query(
    `UPDATE trailer_settings SET ${sets.join(', ')} WHERE id = 1 RETURNING *`,
    vals
  );
  return res.rows[0];
}


module.exports = {
  getTrailerSettings,
  updateTrailerSettings,
};
