'use strict';

/**
 * What the monitor says back — to the driver group, and to the test group.
 *
 * Silent monitoring is the DEFAULT: in the normal configuration nothing is sent
 * back to a driver group at all. Every function here is best-effort and never
 * throws, because a failed reply must not affect registration.
 */

const db = require('../../database/db');
const { buildTelegramMessageUrl } = require('../telegramUrl');
const { reporterName, eventLabel, statePhrase } = require('./eventColumns');
const { messageText, isSilentDriverGroup } = require('./candidateFilter');

/**
 * Emit the driver-group confirmation reply + 👍 reaction for freshly registered
 * events — but ONLY when silent monitoring is off (opt-out) AND the legacy
 * per-channel toggles allow it. In the default (silent) configuration this is a
 * no-op: nothing is sent back to the driver group.
 */
async function maybeReplyAndReact(telegram, group, message, registered, settings, betaMode) {
  if (!registered.length) return;
  if (isSilentDriverGroup(settings)) return; // silent mode → never touch the driver group
  if (settings.send_driver_group_confirmation !== false) {
    await replyConfirmation(telegram, group, message, registered, betaMode);
  }
  if (settings.send_reaction !== false) {
    await reactThumbsUp(telegram, group.telegram_group_id, message.message_id);
  }
}

/** React 👍 on the source message. Never throws. */
async function reactThumbsUp(telegram, chatId, messageId) {
  if (!telegram || !chatId || !messageId) return;
  try {
    const reaction = [{ type: 'emoji', emoji: '👍' }];
    if (typeof telegram.setMessageReaction === 'function') {
      await telegram.setMessageReaction(chatId, messageId, reaction);
    } else if (typeof telegram.callApi === 'function') {
      await telegram.callApi('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction });
    }
  } catch (err) {
    // Reactions are optional (older API / not an admin) — low-noise, never break.
    console.warn('[TRAILER] Could not set reaction (non-fatal):', err.message);
  }
}

/**
 * Send ONE confirmation reply to the driver group summarizing every registered
 * pickup/drop-off from the message. Sent ONLY after the hard approval gate
 * passed and the events were actually stored.
 */
async function replyConfirmation(telegram, group, message, events, betaMode) {
  const list = (Array.isArray(events) ? events : [events]).filter(Boolean);
  if (!list.length) return;
  const chatId = group.telegram_group_id;
  const beta = betaMode ? ' (Beta test mode)' : '';

  const lines = [];
  if (list.length === 1) {
    const event = list[0];
    lines.push(`✅ Trailer ${eventLabel(event.event_type)} registered${beta}`, '');
    lines.push(`Trailer: ${event.trailer_unit_number || 'unknown'}`);
    lines.push(`Status: ${statePhrase(event)}`);
    if (event.location_text) lines.push(`Location: ${event.location_text}`);
    if (event.condition_text) lines.push(`Condition: ${event.condition_text}`);
  } else {
    lines.push(`✅ Trailer updates registered${beta}`, '');
    for (const event of list) {
      lines.push(`${event.trailer_unit_number || 'unknown'} — ${eventLabel(event.event_type)} / ${statePhrase(event)}`);
    }
  }
  try {
    await telegram.sendMessage(chatId, lines.join('\n'), {
      reply_to_message_id: Number(message.message_id),
      allow_sending_without_reply: true,
    });
  } catch (err) {
    console.warn('[TRAILER] Could not send confirmation reply (non-fatal):', err.message);
  }
}

/**
 * Report an unconfirmed / unclear trailer candidate to the Automatic Updating
 * (Test) group. Never sent to the driver group. Never throws.
 */
async function reportUnidentified(telegram, group, message, parsed, event, testGroupId, betaMode) {
  if (!testGroupId) return;
  const from = message.from || {};
  const link = buildTelegramMessageUrl(group.telegram_group_id, message.message_id);
  const beta = betaMode ? ' [Beta]' : '';
  const raw = messageText(message);
  const sem = parsed.semantic || null;
  const lines = [
    sem ? `⚠️ Trailer candidate needs review${beta}` : `⚠️ Unidentified trailer command${beta}`,
    '',
    `Group: ${group.group_name || group.telegram_group_id}`,
    `Sender: ${from.username ? '@' + from.username : ''}${from.username ? ' ' : ''}${reporterName(from) || 'unknown'}`,
    `Detected unit: ${parsed.trailerUnit || '—'}`,
    `Type: ${sem?.intent || parsed.eventType}`,
    `Why: ${parsed.reason || 'unclear'}`,
  ];
  if (sem) {
    if (sem.confidence != null) lines.push(`AI confidence: ${sem.confidence}`);
    if (sem.unitEvidence) lines.push(`Unit evidence: ${String(sem.unitEvidence).slice(0, 200)}`);
    if (sem.actionEvidence) lines.push(`Action evidence: ${String(sem.actionEvidence).slice(0, 200)}`);
    lines.push('No status was changed.');
  }
  if (raw) lines.push('', `Message: ${raw.slice(0, 500)}`);
  if (link) lines.push('', link);
  try {
    await telegram.sendMessage(testGroupId, lines.join('\n'), { disable_web_page_preview: true });
    if (event?.id) await db.query('UPDATE trailer_events SET reported_to_test_group = TRUE WHERE id = $1', [event.id]).catch(() => {});
  } catch (err) {
    console.warn('[TRAILER] Could not send test-group report (non-fatal):', err.message);
  }
}

module.exports = {
  maybeReplyAndReact,
  reactThumbsUp,
  replyConfirmation,
  reportUnidentified,
};
