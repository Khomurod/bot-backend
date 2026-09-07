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
 */
const db = require('../database/db');
const rc = require('../database/ringcentral');
const { sendSms, sendSmsAsRecruiter } = require('./ringCentralSmsService');
const { sendTelegramHtmlChunks, safeSend } = require('./telegramHtml');
const { toSupergroupStyleChatId } = require('./leadsTelegramClient');

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function candidateTelegramChatIds(chatId) {
  const raw = String(chatId).trim();
  const candidates = new Set();
  const asNum = Number(raw);
  if (Number.isFinite(asNum)) candidates.add(asNum);

  if (raw.startsWith('-100')) {
    const abs = raw.slice(4);
    const legacy = Number(`-${abs}`);
    if (Number.isFinite(legacy)) candidates.add(legacy);
  } else if (raw.startsWith('-')) {
    const abs = raw.slice(1);
    const supergroup = Number(`-100${abs}`);
    if (Number.isFinite(supergroup)) candidates.add(supergroup);
  }

  return [...candidates];
}

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

/** "Jane Doe (+14704804679)", "+14704804679", or '' when nothing is known. */
function describeSender(sender) {
  const name = String(sender?.name || '').trim();
  const number = String(sender?.fromNumber || '').trim();
  if (name && number) return `${name} (${number})`;
  return name || number || '';
}

async function findMirrorByTelegramMessage(telegramChatId, telegramMessageId) {
  for (const chatId of candidateTelegramChatIds(telegramChatId)) {
    const row = await db.getFacebookLeadSmsMirror(chatId, telegramMessageId);
    if (row) return row;
  }
  return null;
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
}) {
  if (!telegram || chatId == null || chatId === '') {
    return { ok: false, reason: 'not_configured' };
  }

  const sendChatId = toSupergroupStyleChatId(chatId);
  let html = buildAutoMessageSentHtml(phone, smsBody, { name: recruiterName, fromNumber });
  // Why it came from the shared number rather than the assigned recruiter's —
  // an expired RingCentral login otherwise looks identical to success.
  if (senderNote) html += `\n<i>⚠️ ${escapeHtml(senderNote)}</i>`;
  const sentMessages = await sendTelegramHtmlChunks(telegram, sendChatId, html);
  const first = sentMessages[0];
  const telegramMessageId = first?.message_id;
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

  const allowedSources = new Set(['outbound_auto', 'inbound_rc']);
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

  return { ok: true, mirror: row };
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

async function handleTelegramSmsReply(telegram, {
  telegramChatId,
  replyToMessageId,
  replyText,
  userReplyMessageId = null,
}) {
  const text = String(replyText || '').trim();
  if (!text) {
    const err = new Error('replyText is required');
    err.statusCode = 400;
    throw err;
  }

  const mirror = await findMirrorByTelegramMessage(telegramChatId, replyToMessageId);
  if (!mirror) {
    const err = new Error('No auto-SMS mirror found for that message');
    err.statusCode = 404;
    throw err;
  }

  const { smsResult, sender } = await sendReplyFromMirror(mirror, text);
  if (!smsResult.ok) {
    const err = new Error(smsResult.detail || smsResult.reason || 'SMS send failed');
    err.statusCode = 502;
    err.smsResult = smsResult;
    throw err;
  }

  if (telegram && userReplyMessageId) {
    const confirmChatId = mirror.telegram_chat_id;
    const fromLabel = sender.fromNumber ? ` from ${escapeHtml(sender.fromNumber)}` : '';
    const confirmText = `✅ Sent via SMS to ${escapeHtml(mirror.driver_phone)}${fromLabel}`;
    try {
      await safeSend(() => telegram.sendMessage(confirmChatId, confirmText, {
        parse_mode: 'HTML',
        reply_to_message_id: userReplyMessageId,
      }));
    } catch (confirmErr) {
      console.warn('[FacebookLeadSmsMirror] Confirmation reply failed:', confirmErr.message);
    }
  }

  return {
    ok: true,
    phone: mirror.driver_phone,
    fromNumber: sender.fromNumber,
    via: sender.via,
    messageId: smsResult.messageId,
    conversationId: smsResult.conversationId,
  };
}

/**
 * Send one reply on the mirror's own number, falling back to the shared number
 * rather than losing the reply — a driver waiting on an answer is worse than an
 * answer from the wrong number, and the fallback is logged for the operator.
 */
async function sendReplyFromMirror(mirror, text) {
  const recruiterId = Number(mirror?.recruiter_id);
  if (Number.isFinite(recruiterId) && recruiterId > 0) {
    let recruiter = null;
    try {
      recruiter = await rc.getRecruiterById(recruiterId);
    } catch (err) {
      console.warn('[FacebookLeadSmsMirror] Could not load the mirror recruiter:', err.message);
    }
    if (recruiter && rc.recruiterCanSendSms(recruiter)) {
      const attempt = await sendSmsAsRecruiter(recruiter, mirror.driver_phone, text);
      if (attempt.ok) {
        return {
          smsResult: attempt,
          sender: { via: 'recruiter', recruiterId, fromNumber: attempt.fromNumber || recruiter.phone_number },
        };
      }
      console.warn(
        `[FacebookLeadSmsMirror] Reply from ${recruiter.name || `recruiter ${recruiterId}`} failed `
        + `(${attempt.reason}) — using the shared number.`
      );
    }
  }

  const smsResult = await sendSms(mirror.driver_phone, text);
  return {
    smsResult,
    sender: { via: 'shared', recruiterId: null, fromNumber: smsResult.ok ? (smsResult.fromNumber || null) : null },
  };
}

module.exports = {
  escapeHtml,
  describeSender,
  buildAutoMessageSentHtml,
  candidateTelegramChatIds,
  sendAutoMessageSentNotice,
  registerSmsMirror,
  resolveSenderForNumber,
  handleTelegramSmsReply,
  sendReplyFromMirror,
  findMirrorByTelegramMessage,
};
