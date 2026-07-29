/**
 * Home-Time internal clarification alert.
 *
 * When driver-group messaging is off (see services/homeTimeDriverChannel), the
 * bot must not ask the driver anything — but the request still exists and still
 * needs its exact dates. This module tells STAFF instead: one message to the
 * configured internal group, tagging the approvers, with everything a human
 * needs to go and ask the driver themselves.
 *
 * Delivery is backed by a DURABLE OUTBOX (database/homeTimeInternalAlertOutbox,
 * migration 0002), not by an in-memory attempt:
 *
 *   - the alert is enqueued in Postgres BEFORE any Telegram call, so a crash, a
 *     Telegram outage or an unconfigured group leaves it pending, never lost;
 *   - workers take a LEASED claim, so two of them cannot send the same alert,
 *     and a worker that dies mid-send simply lets its lease expire;
 *   - failures back off and retry, bounded, until delivered or permanently
 *     failed;
 *   - a delivered alert is terminal and can never be sent twice.
 *
 * runInternalAlertSweep() is the retry worker; it rides the reminder service's
 * cadence but is a separate responsibility.
 */
const ht = require('../database/homeTime');
const outbox = require('../database/homeTimeInternalAlertOutbox');
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
 * Render the alert text for a request row (+ optional live context from the
 * message that triggered it). Split out so both the immediate attempt and the
 * retry worker produce identical text from whatever they have.
 */
function renderAlertForRequest(request, { group, message, verdict, window } = {}) {
  const missingFields = window?.missingFields
    || (request.missing_fields ? String(request.missing_fields).split(',') : []);
  return buildInternalAlertText({
    requestId: request.id,
    driverName: request.driver_name,
    unitNumber: request.unit_number,
    groupName: group?.group_name || request.group_name,
    messageText: message?.text || message?.caption || '',
    messageLink: buildMessageLink({
      telegramGroupId: group?.telegram_group_id || request.telegram_group_id || request.root_chat_id,
      groupUsername: group?.telegram_username || group?.username,
      messageId: message?.message_id || request.root_message_id,
    }),
    detectedIntent: verdict?.intent || request.detected_intent,
    homeStartDate: window?.homeStartDate || request.home_from,
    returnToRoadDate: window?.returnToRoadDate || request.return_to_road_date,
    missingFields,
    reason: verdict?.reason || request.ai_reasoning,
  });
}

/** The configured internal staff chat id, or null when unset. */
function internalChatId(settings) {
  return settings?.internal_clarification_group_id
    ? String(settings.internal_clarification_group_id)
    : null;
}

/**
 * Deliver ONE already-claimed alert and settle its outbox state.
 *
 * The caller owns the lease; this function always resolves it — delivered on
 * success, backoff-scheduled on failure. It never throws.
 */
async function deliverClaimedAlert(telegram, claimed, chatId, context = {}) {
  const text = renderAlertForRequest(claimed, context);
  try {
    await safeSend(() => telegram.sendMessage(chatId, text, {
      parse_mode: 'HTML', disable_web_page_preview: true,
    }));
  } catch (sendErr) {
    const row = await outbox.markInternalAlertFailed(claimed.id, { error: sendErr.message })
      .catch(() => null);
    const state = row?.internal_alert_state || 'pending';
    console.error(`[HOME-TIME-INTERNAL] Request #${claimed.id}: alert send failed `
      + `(attempt ${claimed.internal_alert_attempts}, now ${state}):`, sendErr.message);
    return { sent: false, reason: state === 'failed' ? 'permanently_failed' : 'send_failed' };
  }
  await outbox.markInternalAlertDelivered(claimed.id).catch(() => {});
  console.log(`[HOME-TIME-INTERNAL] Request #${claimed.id}: staff clarification alert delivered to ${chatId}.`);
  return { sent: true };
}

/**
 * Queue the internal alert for a request and attempt it immediately.
 *
 * The ENQUEUE is the durable part: it lands in the database before any Telegram
 * call, so a crash — or a Telegram outage, or an unconfigured group — leaves the
 * alert pending and the worker picks it up later. The immediate attempt is only
 * an optimisation so staff normally hear within seconds rather than on the next
 * sweep.
 *
 * Never throws: a failed alert must not take down the request workflow.
 *
 * @returns {Promise<{sent:boolean, reason?:string}>}
 */
async function notifyInternalClarification(telegram, {
  request, group, message, verdict, settings, window,
} = {}) {
  try {
    if (!request || !request.id) return { sent: false, reason: 'no_request' };

    // Durable first — this is what makes the alert survive a crash.
    await outbox.enqueueInternalAlert(request.id);

    const chatId = internalChatId(settings);
    if (!chatId) {
      console.warn(`[HOME-TIME-INTERNAL] Request #${request.id}: internal clarification group is not `
        + 'configured — alert left PENDING and will deliver once a group is set. '
        + 'The request is recorded and visible in the admin panel.');
      return { sent: false, reason: 'not_configured' };
    }

    // Lease-based claim: concurrent callers cannot both send, and a crash after
    // claiming just lets the lease expire so the worker retries.
    const claimed = await outbox.claimInternalAlertById(request.id);
    if (!claimed) {
      console.log(`[HOME-TIME-INTERNAL] Request #${request.id}: alert already delivered or claimed — no duplicate.`);
      return { sent: false, reason: 'already_sent' };
    }

    return await deliverClaimedAlert(telegram, claimed, chatId, {
      group, message, verdict, window,
    });
  } catch (err) {
    console.error('[HOME-TIME-INTERNAL] notifyInternalClarification error:', err.message);
    return { sent: false, reason: 'error' };
  }
}

/**
 * Retry worker: deliver every internal alert that is due.
 *
 * Restart-safe by construction — all state lives in Postgres timestamps, so
 * there is no in-memory timer to lose. Runs on the reminder service's cadence
 * but is a separate responsibility: reminders chase DRIVERS, this chases STAFF.
 *
 * When no internal group is configured nothing is claimed at all, so pending
 * alerts keep their full attempt budget and deliver as soon as one is set.
 *
 * @returns {{ configured:boolean, claimed:number, sent:number, failed:number }}
 */
async function runInternalAlertSweep(telegram, { nowIso = null, limit = 10 } = {}) {
  const settings = await ht.getHomeTimeSettings();
  if (!settings || !settings.enabled) {
    return {
      configured: false, claimed: 0, sent: 0, failed: 0, reason: 'tracking_disabled',
    };
  }
  const chatId = internalChatId(settings);
  if (!chatId) {
    const waiting = await outbox.countPendingInternalAlerts({ nowIso }).catch(() => 0);
    if (waiting) {
      console.warn(`[HOME-TIME-INTERNAL] ${waiting} staff alert(s) pending but no internal `
        + 'clarification group is configured — nothing claimed, they will deliver once it is set.');
    }
    return {
      configured: false, claimed: 0, sent: 0, failed: 0, reason: 'not_configured',
    };
  }

  const claimedRows = await outbox.claimDueInternalAlerts({ nowIso, limit });
  let sent = 0;
  let failed = 0;
  for (const row of claimedRows) {
    // eslint-disable-next-line no-await-in-loop
    const res = await deliverClaimedAlert(telegram, row, chatId);
    if (res.sent) sent += 1; else failed += 1;
  }
  if (claimedRows.length) {
    console.log(`[HOME-TIME-INTERNAL] Sweep: claimed ${claimedRows.length}, delivered ${sent}, failed ${failed}.`);
  }
  return {
    configured: true, claimed: claimedRows.length, sent, failed,
  };
}

module.exports = {
  MAX_QUOTED_MESSAGE_CHARS,
  buildMessageLink,
  buildInternalAlertText,
  renderAlertForRequest,
  deliverClaimedAlert,
  notifyInternalClarification,
  runInternalAlertSweep,
};
