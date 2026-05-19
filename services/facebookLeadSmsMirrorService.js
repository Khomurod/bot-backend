const db = require('../database/db');
const { sendSms } = require('./ringCentralSmsService');
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

function buildAutoMessageSentHtml(phone, smsBody) {
  const phoneEsc = escapeHtml(phone || '');
  const bodyEsc = escapeHtml(smsBody || '');
  return `AutoMessage sent via SMS to ${phoneEsc}:\n<pre>${bodyEsc}</pre>`;
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
}) {
  if (!telegram || chatId == null || chatId === '') {
    return { ok: false, reason: 'not_configured' };
  }

  const sendChatId = toSupergroupStyleChatId(chatId);
  const html = buildAutoMessageSentHtml(phone, smsBody);
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
  });

  return { ok: true, mirror: row };
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

  const smsResult = await sendSms(mirror.driver_phone, text);
  if (!smsResult.ok) {
    const err = new Error(smsResult.detail || smsResult.reason || 'SMS send failed');
    err.statusCode = 502;
    err.smsResult = smsResult;
    throw err;
  }

  if (telegram && userReplyMessageId) {
    const confirmChatId = mirror.telegram_chat_id;
    const confirmText = `✅ Sent via SMS to ${escapeHtml(mirror.driver_phone)}`;
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
    messageId: smsResult.messageId,
    conversationId: smsResult.conversationId,
  };
}

module.exports = {
  escapeHtml,
  buildAutoMessageSentHtml,
  candidateTelegramChatIds,
  sendAutoMessageSentNotice,
  registerSmsMirror,
  handleTelegramSmsReply,
  findMirrorByTelegramMessage,
};
