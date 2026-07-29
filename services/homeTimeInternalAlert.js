/**
 * Home-Time internal clarification alert.
 *
 * When driver-group messaging is off (see services/homeTimeDriverChannel), the
 * bot must not ask the driver anything — but the request still exists and still
 * needs its exact dates. This module tells STAFF instead: one message to the
 * configured internal group, tagging the approvers, with everything a human
 * needs to go and ask the driver themselves.
 *
 * Duplicate prevention is DB-atomic, not in-memory: the alert is only sent by
 * whoever wins `claimInternalClarificationAlert`, so concurrent ticks, retries
 * and process restarts can never post the same request twice. A failed send
 * releases the claim so the next pass can retry.
 */
const ht = require('../database/homeTime');
const { safeSend } = require('./telegramHtml');
const { buildTelegramMessageUrl } = require('./telegramUrl');
const { HOME_TIME_APPROVER_MENTIONS } = require('./homeTimeRequestConstants');

const MAX_QUOTED_MESSAGE_CHARS = 500;

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * A link to the original driver message when one can be derived.
 *   - public group with a username → https://t.me/<username>/<id>
 *   - supergroup (-100…)          → https://t.me/c/<id without -100>/<id>
 *   - otherwise                   → null (the alert simply omits the line)
 */
function buildMessageLink({ telegramGroupId, groupUsername, messageId } = {}) {
  const msgId = Number(messageId);
  if (!Number.isInteger(msgId) || msgId <= 0) return null;
  const username = String(groupUsername || '').replace(/^@/, '').trim();
  if (username) return `https://t.me/${username}/${msgId}`;
  return buildTelegramMessageUrl(telegramGroupId, msgId);
}

/** Human label for a date field we still need from the driver. */
const MISSING_FIELD_LABELS = {
  home_start: 'arrive-home date',
  return_to_road: 'return-to-road date',
};

function describeMissing(missingFields) {
  const list = (Array.isArray(missingFields) ? missingFields : String(missingFields || '').split(','))
    .map((f) => String(f || '').trim())
    .filter(Boolean);
  if (!list.length) return null;
  return list.map((f) => MISSING_FIELD_LABELS[f] || f).join(' and ');
}

function describeKnown({ homeStartDate, returnToRoadDate } = {}) {
  const parts = [];
  if (homeStartDate) parts.push(`arrives home <b>${escapeHtml(homeStartDate)}</b>`);
  if (returnToRoadDate) parts.push(`back on the road <b>${escapeHtml(returnToRoadDate)}</b>`);
  return parts.length ? parts.join(', ') : null;
}

/**
 * Build the internal alert text. Pure — no I/O — so the exact wording is
 * unit-testable. HTML parse mode; every interpolated value is escaped.
 */
function buildInternalAlertText({
  driverName, unitNumber, groupName, messageText, messageLink,
  detectedIntent, homeStartDate, returnToRoadDate, missingFields,
  reason, requestId,
} = {}) {
  const who = [
    escapeHtml(driverName || 'Unknown driver'),
    unitNumber ? `Unit ${escapeHtml(unitNumber)}` : null,
  ].filter(Boolean).join(' — ');

  const lines = [
    '🏠 <b>Home-time clarification needed</b>',
    '',
    `<b>Driver:</b> ${who}`,
    `<b>Driver group:</b> ${escapeHtml(groupName || 'Unknown group')}`,
  ];

  const quoted = String(messageText || '').slice(0, MAX_QUOTED_MESSAGE_CHARS);
  if (quoted) {
    lines.push('', '<b>Original message:</b>', `<blockquote>${escapeHtml(quoted)}</blockquote>`);
  }
  if (messageLink) lines.push(`<a href="${escapeHtml(messageLink)}">Open the original message</a>`);

  lines.push('');
  if (detectedIntent) lines.push(`<b>Detected:</b> ${escapeHtml(detectedIntent)}`);

  const known = describeKnown({ homeStartDate, returnToRoadDate });
  lines.push(`<b>Dates identified:</b> ${known || 'none yet'}`);

  const missing = describeMissing(missingFields);
  lines.push(`<b>Still missing:</b> ${missing ? escapeHtml(missing) : 'nothing — dates are complete'}`);

  if (reason) lines.push(`<b>Why:</b> ${escapeHtml(String(reason).slice(0, 300))}`);

  lines.push(
    '',
    'The bot is <b>not</b> messaging driver groups right now, so the driver has '
    + '<b>not</b> been asked. Please confirm the exact arrive-home and '
    + 'return-to-road dates with the driver and enter them in the admin panel.',
    '',
    HOME_TIME_APPROVER_MENTIONS.join(' '),
  );
  if (requestId) lines.push(`<i>Request #${requestId}</i>`);

  return lines.join('\n');
}

/**
 * Send the internal clarification alert for a request, at most once, ever.
 *
 * Never throws — a failed alert must not take down the request workflow that
 * created it. Returns a small result object describing what happened so callers
 * and tests can assert on it.
 *
 * @returns {Promise<{sent:boolean, reason?:string}>}
 */
async function notifyInternalClarification(telegram, {
  request, group, message, verdict, settings, window,
} = {}) {
  try {
    if (!request || !request.id) return { sent: false, reason: 'no_request' };

    const chatId = settings?.internal_clarification_group_id
      ? String(settings.internal_clarification_group_id)
      : null;
    if (!chatId) {
      console.warn(`[HOME-TIME-INTERNAL] Request #${request.id}: internal clarification group is not `
        + 'configured — no alert sent. The request is still recorded and visible in the admin panel.');
      return { sent: false, reason: 'not_configured' };
    }

    // Atomic claim: only the winner sends. Guards against concurrent ticks,
    // retries and restarts double-posting the same request.
    const claimed = await ht.claimInternalClarificationAlert(request.id);
    if (!claimed) {
      console.log(`[HOME-TIME-INTERNAL] Request #${request.id}: internal alert already sent — skipping duplicate.`);
      return { sent: false, reason: 'already_sent' };
    }

    const missingFields = window?.missingFields
      || (request.missing_fields ? String(request.missing_fields).split(',') : []);
    const text = buildInternalAlertText({
      requestId: request.id,
      driverName: request.driver_name,
      unitNumber: request.unit_number,
      groupName: group?.group_name,
      messageText: message?.text || message?.caption || '',
      messageLink: buildMessageLink({
        telegramGroupId: group?.telegram_group_id,
        groupUsername: group?.telegram_username || group?.username,
        messageId: message?.message_id,
      }),
      detectedIntent: verdict?.intent || request.detected_intent,
      homeStartDate: window?.homeStartDate || request.home_from,
      returnToRoadDate: window?.returnToRoadDate || request.return_to_road_date,
      missingFields,
      reason: verdict?.reason || request.ai_reasoning,
    });

    try {
      await safeSend(() => telegram.sendMessage(chatId, text, {
        parse_mode: 'HTML', disable_web_page_preview: true,
      }));
    } catch (sendErr) {
      // Release the claim so a later pass can retry instead of the request being
      // silently marked as alerted when nothing was delivered.
      await ht.releaseInternalClarificationAlert(request.id).catch(() => {});
      console.error(`[HOME-TIME-INTERNAL] Request #${request.id}: alert send failed, claim released:`, sendErr.message);
      return { sent: false, reason: 'send_failed' };
    }

    console.log(`[HOME-TIME-INTERNAL] Request #${request.id}: staff clarification alert sent to ${chatId}.`);
    return { sent: true };
  } catch (err) {
    console.error('[HOME-TIME-INTERNAL] notifyInternalClarification error:', err.message);
    return { sent: false, reason: 'error' };
  }
}

module.exports = {
  MAX_QUOTED_MESSAGE_CHARS,
  buildMessageLink,
  buildInternalAlertText,
  notifyInternalClarification,
};
