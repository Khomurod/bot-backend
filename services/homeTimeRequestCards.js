/**
 * Home-Time Request — Telegram card presentation (pure text + inline keyboard).
 *
 * These builders were extracted verbatim from homeTimeRequestService.js as a
 * focused, side-effect-free module (see CLAUDE.md → "Maximum source-file size":
 * split by cohesive responsibility, keep a re-export façade). The request service
 * imports and re-exports every symbol here, so its public surface — and every
 * existing importer (bot/homeTimeRequestHandlers.js uses CALLBACK_PREFIX +
 * buildDecidedCardText) — is unchanged.
 *
 * No DB, network, or Telegram send happens here; the service still owns all I/O.
 */
const { Markup } = require('telegraf');
const {
  HOME_TIME_APPROVER_MENTIONS,
  weeksFromDays,
  homeTimePolicyApplies,
} = require('./homeTimeRequestConstants');

// Inline-button callback namespace for the Approve / Do Not Approve card. Kept
// here (with buildDecisionButtons) and re-exported by the request service so the
// decision handler and the card stay in agreement on the prefix.
const CALLBACK_PREFIX = 'htreq';

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function approverTagLine() {
  return HOME_TIME_APPROVER_MENTIONS.join(' / ');
}

function buildCardText({
  driverName, unitNumber, driverType, text, daysOnRoad, policyMet, homeFrom, homeTo, returnToRoadDate,
}) {
  const who = `${escapeHtml(driverName)}${unitNumber ? ` (Unit ${escapeHtml(unitNumber)})` : ''}`;
  const policyApplies = homeTimePolicyApplies(driverType);
  const flag = policyMet === false ? '⚠️ ' : '';
  const backOnRoad = returnToRoadDate
    ? ` — back on the road <b>${escapeHtml(returnToRoadDate)}</b>`
    : '';
  const lines = [
    `🏠 <b>Home-Time Request — ${who}</b>`,
    '',
    `${flag}${escapeHtml(text)}`,
    '',
    `Driver type: <b>${policyApplies ? 'Company driver' : 'Owner operator'}</b>`,
    `Home time: <b>${escapeHtml(homeFrom)} → ${escapeHtml(homeTo)}</b>${backOnRoad}`,
  ];
  if (daysOnRoad != null) {
    lines.push(`On the road: <b>${daysOnRoad} days</b> (~${weeksFromDays(daysOnRoad)} weeks)`);
  }
  if (!policyApplies) {
    lines.push('Policy: <b>N/A</b> (owner operator)');
  }
  lines.push('', `Only ${approverTagLine()} can decide.`);
  return lines.join('\n');
}

function buildDecisionButtons(requestId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Approve', `${CALLBACK_PREFIX}:approve:${requestId}`),
      Markup.button.callback('❌ Do Not Approve', `${CALLBACK_PREFIX}:deny:${requestId}`),
    ],
  ]);
}

function buildDecidedCardText(request, decision, decidedByUsername, { via } = {}) {
  const who = `${escapeHtml(request.driver_name || 'Driver')}`
    + `${request.unit_number ? ` (Unit ${escapeHtml(request.unit_number)})` : ''}`;
  const by = decidedByUsername ? `@${escapeHtml(decidedByUsername)}` : 'a manager';
  // The card reflects WHERE the decision was made. Telegram (the default) keeps
  // its original wording; an admin-panel decision is labelled so the group sees
  // the card is settled and no longer actionable.
  const source = via === 'admin' ? ' via the admin panel' : '';
  const verdict = decision === 'approved'
    ? `✅ <b>Approved</b> by ${by}${source}`
    : `❌ <b>Not approved</b> by ${by}${source}`;
  const back = request.return_to_road_date
    ? ` — back on the road <b>${escapeHtml(request.return_to_road_date)}</b>`
    : '';
  return [
    `🏠 <b>Home-Time Request — ${who}</b>`,
    '',
    verdict,
    `Home time: <b>${escapeHtml(request.home_from || '—')} → ${escapeHtml(request.home_to || '—')}</b>${back}`,
  ].join('\n');
}

/**
 * Card text for a request that was auto-closed as "Expired — No Action" (its
 * requested dates passed with no human decision). Mirrors buildDecidedCardText:
 * editing the message with this text and NO reply_markup removes the buttons, so
 * the card in the group clearly shows the request is closed and not actionable.
 */
function buildExpiredCardText(request) {
  const who = `${escapeHtml(request.driver_name || 'Driver')}`
    + `${request.unit_number ? ` (Unit ${escapeHtml(request.unit_number)})` : ''}`;
  const back = request.return_to_road_date
    ? ` — back on the road <b>${escapeHtml(request.return_to_road_date)}</b>`
    : '';
  return [
    `🏠 <b>Home-Time Request — ${who}</b>`,
    '',
    '⌛ <b>Expired — No Action</b>',
    'The requested home-time dates passed with no decision, so this request is closed and no longer actionable.',
    `Home time: <b>${escapeHtml(request.home_from || '—')} → ${escapeHtml(request.home_to || '—')}</b>${back}`,
  ].join('\n');
}

module.exports = {
  CALLBACK_PREFIX,
  escapeHtml,
  approverTagLine,
  buildCardText,
  buildDecisionButtons,
  buildDecidedCardText,
  buildExpiredCardText,
};
