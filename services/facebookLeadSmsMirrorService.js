const config = require('../config/config');
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

function buildMirrorHtml({ leadName, phone, pageName, ruleLabel, smsBody }) {
  const name = escapeHtml(leadName || 'Lead');
  const phoneEsc = escapeHtml(phone || '');
  const pageEsc = escapeHtml(pageName || '');
  const ruleSuffix = ruleLabel ? ` (${escapeHtml(ruleLabel)})` : '';
  const bodyEsc = escapeHtml(smsBody || '');

  const lines = [
    `📤 <b>Auto-SMS</b> to ${name} (${phoneEsc})`,
  ];
  if (pageEsc) {
    lines.push(`Page: ${pageEsc}${ruleSuffix}`);
  } else if (ruleSuffix) {
    lines.push(`Rule${ruleSuffix}`);
  }
  lines.push(`<pre>${bodyEsc}</pre>`);
  return lines.join('\n');
}

async function findMirrorByTelegramMessage(telegramChatId, telegramMessageId) {
  for (const chatId of candidateTelegramChatIds(telegramChatId)) {
    const row = await db.getFacebookLeadSmsMirror(chatId, telegramMessageId);
    if (row) return row;
  }
  return null;
}

async function mirrorAutoSmsToLeadsHub(telegram, {
  chatId,
  phone,
  smsBody,
  leadName,
  pageName,
  pageId,
  ruleLabel,
  ringcentralMessageId,
}) {
  const hubChatId = String(chatId || config.leadsTelegramChatId || '').trim();
  if (!hubChatId || !telegram) {
    return { ok: false, reason: 'not_configured' };
  }

  const sendChatId = toSupergroupStyleChatId(hubChatId);
  const html = buildMirrorHtml({ leadName, phone, pageName, ruleLabel, smsBody });
  const sentMessages = await sendTelegramHtmlChunks(telegram, sendChatId, html);
  const first = sentMessages[0];
  const telegramMessageId = first?.message_id;
  const resolvedChatId = first?.chat?.id ?? sendChatId;

  if (!telegramMessageId) {
    console.warn('[FacebookLeadSmsMirror] Mirror send did not return message_id');
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
  });

  return { ok: true, telegramMessageId, telegramChatId: resolvedChatId };
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
  buildMirrorHtml,
  candidateTelegramChatIds,
  mirrorAutoSmsToLeadsHub,
  handleTelegramSmsReply,
  findMirrorByTelegramMessage,
};
