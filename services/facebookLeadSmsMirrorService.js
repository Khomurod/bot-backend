/**
 * The two-way SMS mirror: a lead's text appears in Telegram, and a reply typed
 * in Telegram goes back out as an SMS.
 *
 * THE REPLY MUST LEAVE FROM THE NUMBER THE DRIVER WAS TEXTED FROM. Each mirror
 * row remembers its sender (recruiter_id + from_number), so a driver answering
 * the recruiter who contacted them keeps talking to that recruiter's number
 * rather than being handed to the shared company line mid-conversation. A
 * mirror with no sender — every row written before per-recruiter sending, and
 * every lead that fell back — still uses the shared number exactly as before.
 *
 * This file is now the OUTBOUND half plus a façade over two others, split when
 * it passed the size limit. Every symbol it used to export it still exports:
 *
 *   ./facebookLeads/smsMirrorLookup   finding the row a message belongs to
 *   ./facebookLeads/smsReplyRelay     carrying a recruiter's reply back out
 */
const db = require('../database/db');
const rc = require('../database/ringcentral');
const { sendTelegramHtmlChunks } = require('./telegramHtml');
const { sendToChatIdWithFallback } = require('./leadsTelegramClient');
const { MIRROR_SOURCES } = require('../lib/recruiting/thread');
const { considerAfterHoursReply } = require('./recruiting/afterHoursThread');
const lookup = require('./facebookLeads/smsMirrorLookup');
const replyRelay = require('./facebookLeads/smsReplyRelay');

const { escapeHtml, describeSender } = lookup;

/**
 * @param {string} phone
 * @param {string} smsBody
 * @param {{name?: string|null, fromNumber?: string|null}|null} [sender]
 *   Who sent it. Omitted (the shared company number) the wording is unchanged.
 */
function buildAutoMessageSentHtml(phone, smsBody, sender = null) {
  const phoneEsc = escapeHtml(phone || '');
  const bodyEsc = escapeHtml(smsBody || '');
  const from = describeSender(sender);
  const fromEsc = from ? ` from ${escapeHtml(from)}` : '';
  return `AutoMessage sent via SMS to ${phoneEsc}${fromEsc}:\n<pre>${bodyEsc}</pre>`;
}

async function sendAutoMessageSentNotice(telegram, chatId, {
  phone,
  smsBody,
  leadName = null,
  pageId = null,
  ruleLabel = null,
  ringcentralMessageId = null,
  recruiterId = null,
  recruiterName = null,
  fromNumber = null,
  senderNote = null,
  fallbackReason = null,
}) {
  if (!telegram || chatId == null || chatId === '') {
    return { ok: false, reason: 'not_configured' };
  }

  let html = buildAutoMessageSentHtml(phone, smsBody, { name: recruiterName, fromNumber });
  // Why it came from the shared number rather than the assigned recruiter's —
  // an expired RingCentral login otherwise looks identical to success.
  if (senderNote) html += `\n<i>⚠️ ${escapeHtml(senderNote)}</i>`;

  // The id AS STORED first. This used to be `toSupergroupStyleChatId(chatId)`
  // unconditionally, which turned the working group id — the same one the lead
  // post uses verbatim a few steps earlier — into a chat that does not exist.
  // Telegram answers `400 chat not found`, which telegramHtml classifies as
  // PERMANENT, so it threw before the mirror insert below and every lead lost
  // its `outbound_auto` row along with the notice.
  //
  // A retry re-sends every chunk. That is safe here because the errors it
  // retries on — the chat does not exist, or has been replaced — fail the FIRST
  // chunk, so there is nothing already delivered to duplicate.
  let sendChatId = chatId;
  const sentMessages = await sendToChatIdWithFallback(
    (id) => { sendChatId = id; return sendTelegramHtmlChunks(telegram, id, html); },
    chatId,
  );
  const first = sentMessages[0];
  const telegramMessageId = first?.message_id;
  // Telegram's own answer wins: after a migration it reports the new id, and
  // that is the id a reply will arrive under.
  const resolvedChatId = first?.chat?.id ?? sendChatId;

  if (!telegramMessageId) {
    console.warn('[FacebookLeadSmsMirror] Auto-message notice did not return message_id');
    return { ok: false, reason: 'telegram_send_failed' };
  }

  await db.insertFacebookLeadSmsMirror({
    telegramChatId: resolvedChatId,
    telegramMessageId,
    driverPhone: phone,
    smsBody,
    leadName,
    pageId,
    ruleLabel,
    ringcentralMessageId,
    sourceType: 'outbound_auto',
    recruiterId,
    fromNumber,
    // Queryable, not just rendered into the note above: "which leads went out
    // from the shared number last week, and why" is an operational question.
    fallbackReason,
  });

  return { ok: true, telegramMessageId, telegramChatId: resolvedChatId };
}

async function registerSmsMirror({
  telegramChatId,
  telegramMessageId,
  driverPhone,
  smsBody,
  sourceType = 'outbound_auto',
  leadName = null,
  pageId = null,
  ruleLabel = null,
  ringcentralMessageId = null,
  recruiterId = null,
  fromNumber = null,
  toNumber = null,
}) {
  const phone = String(driverPhone || '').trim();
  if (!phone || phone.toLowerCase() === 'unknown') {
    const err = new Error('driverPhone is required');
    err.statusCode = 400;
    throw err;
  }

  const chatId = Number(telegramChatId);
  const messageId = Number(telegramMessageId);
  if (!Number.isFinite(chatId) || !Number.isFinite(messageId)) {
    const err = new Error('telegramChatId and telegramMessageId are required');
    err.statusCode = 400;
    throw err;
  }

  const body = String(smsBody ?? '');
  if (!body.trim()) {
    const err = new Error('smsBody is required');
    err.statusCode = 400;
    throw err;
  }

  // The four kinds lib/recruiting/thread.js can read, taken FROM it rather than
  // restated, so a kind cannot be insertable here and invisible there.
  const allowedSources = new Set(MIRROR_SOURCES);
  const resolvedSource = allowedSources.has(sourceType) ? sourceType : 'outbound_auto';

  // An inbound SMS arrived AT one of our numbers. That number is the sender for
  // the rest of this conversation, so resolve it to its recruiter once, here.
  const sender = await resolveSenderForNumber({ recruiterId, fromNumber, toNumber });

  const row = await db.insertFacebookLeadSmsMirror({
    telegramChatId: chatId,
    telegramMessageId: messageId,
    driverPhone: phone,
    smsBody: body,
    leadName,
    pageId,
    ruleLabel,
    ringcentralMessageId,
    sourceType: resolvedSource,
    recruiterId: sender.recruiterId,
    fromNumber: sender.fromNumber,
  });

  // A candidate has written. Outside working hours Wenze may carry the
  // conversation; inside them it stands down and the recruiter answers as
  // always.
  //
  // Awaited, but under a DEADLINE the caller cannot exceed. The AI chain's
  // worst case is three providers times five models times a 60-second timeout,
  // and this runs inside an HTTP request the Python leads engine is waiting on.
  // Past twenty seconds it answers `still_working` and the work carries on
  // without the caller — see services/recruiting/afterHoursThread.js. Every
  // path inside returns a named reason and none of them throws, so the insert
  // above is never put at risk.
  let afterHours = null;
  if (resolvedSource === 'inbound_rc') {
    afterHours = await considerAfterHoursReply({
      driverPhone: phone,
      leadName,
      recruiterId: sender.recruiterId,
      telegramChatId: chatId,
    });
  }

  return { ok: true, mirror: row, afterHours };
}

/**
 * Pin a mirror row to one of our numbers. An explicit recruiterId wins; failing
 * that, `toNumber` (the number an inbound SMS reached) is matched against the
 * recruiters' numbers. Unmatched is fine and normal — the shared number is not
 * a recruiter row, and its mirrors carry no sender.
 */
async function resolveSenderForNumber({ recruiterId = null, fromNumber = null, toNumber = null }) {
  const explicitId = Number(recruiterId);
  if (Number.isFinite(explicitId) && explicitId > 0) {
    return { recruiterId: explicitId, fromNumber: fromNumber || null };
  }

  const ourNumber = String(fromNumber || toNumber || '').trim();
  if (!ourNumber) return { recruiterId: null, fromNumber: null };

  try {
    const recruiter = await rc.getRecruiterByNormalizedNumber(rc.normalizePhone(ourNumber));
    return {
      recruiterId: recruiter?.id ?? null,
      fromNumber: recruiter?.phone_number || ourNumber,
    };
  } catch (err) {
    console.warn('[FacebookLeadSmsMirror] Could not match the receiving number to a recruiter:', err.message);
    return { recruiterId: null, fromNumber: ourNumber };
  }
}

/**
 * The façade. Composition and re-export only, listed key by key rather than
 * spread, so adding a helper to one of the parts does not silently widen this
 * module's public surface — the rule `database/ringcentral.js` set.
 */
module.exports = {
  // this file — the outbound half
  buildAutoMessageSentHtml,
  sendAutoMessageSentNotice,
  registerSmsMirror,
  resolveSenderForNumber,
  // ./facebookLeads/smsMirrorLookup
  escapeHtml: lookup.escapeHtml,
  describeSender: lookup.describeSender,
  candidateTelegramChatIds: lookup.candidateTelegramChatIds,
  findMirrorByTelegramMessage: lookup.findMirrorByTelegramMessage,
  // ./facebookLeads/smsReplyRelay — the inbound half
  handleTelegramSmsReply: replyRelay.handleTelegramSmsReply,
  sendReplyFromMirror: replyRelay.sendReplyFromMirror,
  standDownAfterHours: replyRelay.standDownAfterHours,
};
