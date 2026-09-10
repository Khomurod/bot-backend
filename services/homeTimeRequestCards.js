/**
 * Home-Time Request — Telegram card presentation (pure text).
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
const {
  HOME_TIME_MANAGER_MENTIONS,
  weeksFromDays,
  homeTimePolicyApplies,
} = require('./homeTimeRequestConstants');

// The callback namespace of the RETIRED Approve / Do Not Approve buttons. No
// card carries them any more, but cards posted before that change still sit in
// the group with live buttons, so the prefix stays here for the handler that
// answers those presses politely (bot/homeTimeRequestHandlers.js).
const CALLBACK_PREFIX = 'htreq';

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function managerTagLine() {
  return HOME_TIME_MANAGER_MENTIONS.join(' ');
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
  // No question, no buttons: the card reports a request, it does not ask for a
  // decision. The three managers are tagged so they see it.
  lines.push('', managerTagLine());
  return lines.join('\n');
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
 * Card text that RETIRES an old approval card still sitting in the group.
 * Editing the message with this text and no reply_markup removes its buttons.
 */
function buildRetiredCardText(request) {
  const who = `${escapeHtml(request.driver_name || 'Driver')}`
    + `${request.unit_number ? ` (Unit ${escapeHtml(request.unit_number)})` : ''}`;
  return [
    `🏠 <b>Home-Time — ${who}</b>`,
    '',
    'Home time no longer needs approval. Wenze tracks it and tells the managers '
    + 'when the driver asks, when they get home, and when they are back on the road.',
    `Home time: <b>${escapeHtml(request.home_from || '—')} → ${escapeHtml(request.home_to || '—')}</b>`,
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
  managerTagLine,
  buildCardText,
  buildDecidedCardText,
  buildRetiredCardText,
  buildExpiredCardText,
};
