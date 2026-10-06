'use strict';

/**
 * Recording what a driver writes in their group, when the owner has said so.
 *
 * Four retention signals — saying they are leaving, complaints, sentiment,
 * going quiet — read `chat_logs`, and nothing wrote to it, so they answered a
 * reassuring zero from a source that was not listening. The owner decided on
 * 2026-10-06 that Wenze may read driver messages; `driver_chat_capture_settings`
 * holds that decision, and this records a message only while it says yes.
 *
 * WHAT, EXACTLY: the text or caption a PERSON sends in a DRIVER group. Not a
 * bot's message, not another kind of chat, not media. Clipped to 2,000
 * characters. `chat_logs` keeps 30 days (the scheduler's retention pass).
 *
 * NEVER THROWS, NEVER BLOCKS. This runs inside the message handler that also
 * drives Home Time and the fuel monitor; a recording that fails costs the
 * recording and nothing else.
 */
const MAX_TEXT = 2000;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    settings: require('../../database/chatCaptureSettings'),
    logs: require('../../database/chatLogs'),
  };
  /* eslint-enable global-require */
}

/** The name a message is filed under. Pure. */
function senderNameOf(from) {
  if (!from) return 'Unknown';
  const full = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  return from.username ? `@${from.username}` : 'Unknown';
}

/**
 * @returns {Promise<{recorded:boolean, reason?:string}>}
 */
async function captureDriverMessage({ group, message, from }, deps = defaultDeps()) {
  try {
    if (!group || group.group_type !== 'driver') return { recorded: false, reason: 'not_a_driver_group' };
    if (!message || !from || from.is_bot) return { recorded: false, reason: 'not_a_person' };
    const text = String(message.text || message.caption || '').trim();
    if (!text) return { recorded: false, reason: 'no_text' };

    const settings = await deps.settings.getChatCaptureSettings();
    if (!settings.enabled) return { recorded: false, reason: 'capture_off' };

    await deps.logs.logChatMessage(
      group.id,
      from.id ?? null,
      senderNameOf(from),
      text.slice(0, MAX_TEXT),
      message.message_id ?? null
    );
    return { recorded: true };
  } catch (err) {
    console.warn('[CHAT-CAPTURE] could not record a driver message:', err.message);
    return { recorded: false, reason: 'error' };
  }
}

module.exports = { MAX_TEXT, senderNameOf, captureDriverMessage };
