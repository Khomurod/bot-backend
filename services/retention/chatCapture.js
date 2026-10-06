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
 * NOT STAFF. A dispatcher or manager writes in every driver's chat, and the
 * retention signals add a chat's messages up by group — so a dispatcher's
 * "this is unacceptable" would read as the DRIVER complaining, and their
 * daily check-ins would hide a driver who has gone quiet. A sender is staff
 * by the same rule that keeps a dispatcher from being linked to a driver's
 * identity (`lib/identity/telegramResolution.js isStaff`): the bot met them as
 * a dispatcher or admin, or they are in three or more active driver groups.
 * A standing that cannot be read is treated as staff — a message not recorded
 * costs a signal; one recorded against the wrong person invents one.
 *
 * NEVER THROWS, NEVER BLOCKS. This runs inside the message handler that also
 * drives Home Time and the fuel monitor; a recording that fails costs the
 * recording and nothing else.
 */
const { isStaff } = require('../../lib/identity/telegramResolution');

const MAX_TEXT = 2000;
/** How long one sender's standing is remembered. Ten minutes: cheap, and fresh enough. */
const STANDING_MS = 10 * 60 * 1000;
const standingCache = new Map();

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    settings: require('../../database/chatCaptureSettings'),
    standing: require('../../database/chatCaptureSettings').readSenderStanding,
    logs: require('../../database/chatLogs'),
  };
  /* eslint-enable global-require */
}

/** Is this sender somebody who works here? Fails closed: unknown is staff. */
async function senderIsStaff(telegramUserId, deps, now = Date.now()) {
  if (telegramUserId == null) return true;
  const key = String(telegramUserId);
  const hit = standingCache.get(key);
  if (hit && now - hit.at < STANDING_MS) return hit.staff;
  let staff;
  try {
    staff = isStaff(await deps.standing(telegramUserId));
  } catch (_) {
    return true; // not cached — the next message may read it
  }
  if (standingCache.size > 2000) standingCache.clear();
  standingCache.set(key, { at: now, staff });
  return staff;
}

/** For tests. */
function forgetStandings() {
  standingCache.clear();
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
    if (await senderIsStaff(from.id, deps)) return { recorded: false, reason: 'staff' };

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

module.exports = {
  MAX_TEXT, senderNameOf, senderIsStaff, captureDriverMessage, forgetStandings,
};
