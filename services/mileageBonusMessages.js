/**
 * Pure text/markup builders for mileage bonus Telegram messages.
 * No bot or DB dependencies so both the sender service and the callback
 * handler can share them without circular requires.
 */
const {
  ACCOUNTING_MENTIONS,
  REJECTION_ESCALATION_MENTIONS,
} = require('./mileageBonusConstants');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatMiles(value) {
  const n = Math.round(Number(value) || 0);
  return n.toLocaleString('en-US');
}

function formatAmount(value) {
  return `$${(Math.round(Number(value) || 0)).toLocaleString('en-US')}`;
}

function formatDate(value) {
  if (!value) return '—';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * @param {object} data  driver_name, threshold_miles, bonus_amount,
 *                       miles_at_notification, period_start, period_end
 */
function buildBonusCardText(data) {
  const name = escapeHtml(data.driver_name);
  return [
    '🏁 <b>Mileage Bonus Earned</b>',
    '',
    `Driver: <b>${name}</b>`,
    `Milestone: <b>${formatMiles(data.threshold_miles)} miles</b>`,
    `Bonus: <b>${formatAmount(data.bonus_amount)}</b>`,
    '',
    `Period: ${formatDate(data.period_start)} → ${formatDate(data.period_end)}`,
    `Miles in period: <b>${formatMiles(data.miles_at_notification)}</b>`,
    '',
    `${ACCOUNTING_MENTIONS.join(' ')} — please add this bonus in `
      + '<b>Bonus Penalty For Drivers</b>, then confirm below.',
  ].join('\n');
}

/** Rebuilt card text after a decision, with a status footer and no CTA. */
function buildDecidedCardText(record, decision, username) {
  const name = escapeHtml(record.driver_name);
  const who = username ? `@${escapeHtml(String(username).replace(/^@/, ''))}` : 'accounting';
  const footer = decision === 'paid'
    ? `✅ <b>Paid</b> — confirmed by ${who}`
    : `❌ <b>Rejected in Pay</b> — by ${who}`;
  return [
    '🏁 <b>Mileage Bonus</b>',
    '',
    `Driver: <b>${name}</b>`,
    `Milestone: <b>${formatMiles(record.threshold_miles)} miles</b>`,
    `Bonus: <b>${formatAmount(record.bonus_amount)}</b>`,
    '',
    `Period: ${formatDate(record.period_start)} → ${formatDate(record.period_end)}`,
    `Miles in period: <b>${formatMiles(record.miles_at_notification)}</b>`,
    '',
    footer,
  ].join('\n');
}

function buildRejectionFollowupText(record, username) {
  const name = escapeHtml(record.driver_name);
  const who = username ? `@${escapeHtml(String(username).replace(/^@/, ''))}` : 'accounting';
  return [
    '❌ <b>Bonus Rejected in Pay</b>',
    '',
    `Driver: <b>${name}</b>`,
    `Milestone: ${formatMiles(record.threshold_miles)} miles (${formatAmount(record.bonus_amount)})`,
    `Rejected by ${who}.`,
    '',
    `${REJECTION_ESCALATION_MENTIONS.join(' ')} — please review.`,
  ].join('\n');
}

module.exports = {
  escapeHtml,
  formatMiles,
  formatAmount,
  formatDate,
  buildBonusCardText,
  buildDecidedCardText,
  buildRejectionFollowupText,
};
