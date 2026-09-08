const { Telegraf } = require('telegraf');
const { leadsBotToken } = require('../config/telegramBotTokens');
const { safeSend } = require('./telegramHtml');
const { telegramClientOptions } = require('./telegramAgent');

let leadsBot = null;

/**
 * The `-100…` spelling of a group id.
 *
 * ONLY EVER A SECOND GUESS. Telegram reports the same chat under either shape
 * depending on the API surface, and a group that was upgraded to a supergroup
 * changes id — but a plain group's id is NOT its `-100` form, so converting
 * unconditionally turns a working id into "chat not found". Use
 * `sendToChatIdWithFallback` rather than calling this directly.
 */
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
    leadsBot = new Telegraf(ensureLeadsBotToken(), { telegram: telegramClientOptions });
  }
  return leadsBot.telegram;
}

function isChatIdRetryable(err) {
  const desc = String(err?.response?.description || err?.message || '').toLowerCase();
  if (err?.response?.error_code === 400 && desc.includes('chat was upgraded')) return true;
  if (err?.response?.error_code === 400 && desc.includes('chat not found')) return true;
  return false;
}

/**
 * Send to a stored group id, trying the id AS STORED first.
 *
 * The stored id is the one the `/connect` command captured from a real message
 * in that group, so it is right until Telegram migrates the chat. Only a
 * "chat not found" / "chat was upgraded" answer justifies trying the `-100`
 * form — and only then, because for a plain group that form is a different,
 * non-existent chat.
 *
 * This is the whole reason the auto-message notice was failing in production
 * with `400: Bad Request: chat not found` while the lead post 27 lines earlier
 * succeeded on the same id: the notice converted, the lead post did not.
 *
 * @param {(chatId: string|number) => Promise<any>} send  performs one send
 * @param {string|number} chatId                          the stored group id
 */
async function sendToChatIdWithFallback(send, chatId) {
  try {
    return await send(chatId);
  } catch (err) {
    if (!isChatIdRetryable(err)) throw err;
    const altId = toSupergroupStyleChatId(chatId);
    if (String(altId) === String(chatId)) throw err;
    return send(altId);
  }
}

async function sendLeadsMessage(chatId, text) {
  const telegram = getLeadsTelegram();
  return sendToChatIdWithFallback(
    (id) => safeSend(() => telegram.sendMessage(id, text)),
    chatId,
  );
}

module.exports = {
  getLeadsTelegram,
  sendLeadsMessage,
  sendToChatIdWithFallback,
  isChatIdRetryable,
  toSupergroupStyleChatId,
};
