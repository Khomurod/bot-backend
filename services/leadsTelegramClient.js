const { Telegraf } = require('telegraf');
const { leadsBotToken } = require('../config/telegramBotTokens');
const { safeSend } = require('./telegramHtml');

let leadsBot = null;

function toSupergroupStyleChatId(chatId) {
  const s = String(chatId).trim();
  if (s.startsWith('-100')) return s;
  const abs = s.replace(/^-/, '');
  return `-100${abs}`;
}

function ensureLeadsBotToken() {
  const token = String(leadsBotToken || '').trim();
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured (WenzeLeadBots)');
  }
  return token;
}

function getLeadsTelegram() {
  if (!leadsBot) {
    leadsBot = new Telegraf(ensureLeadsBotToken());
  }
  return leadsBot.telegram;
}

function isChatIdRetryable(err) {
  const desc = String(err?.response?.description || err?.message || '').toLowerCase();
  if (err?.response?.error_code === 400 && desc.includes('chat was upgraded')) return true;
  if (err?.response?.error_code === 400 && desc.includes('chat not found')) return true;
  return false;
}

async function sendLeadsMessage(chatId, text) {
  const telegram = getLeadsTelegram();
  const primaryId = chatId;

  try {
    return await safeSend(() => telegram.sendMessage(primaryId, text));
  } catch (err) {
    if (!isChatIdRetryable(err)) throw err;
    const altId = toSupergroupStyleChatId(primaryId);
    if (String(altId) === String(primaryId)) throw err;
    return safeSend(() => telegram.sendMessage(altId, text));
  }
}

module.exports = {
  getLeadsTelegram,
  sendLeadsMessage,
  toSupergroupStyleChatId,
};
