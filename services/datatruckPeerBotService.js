/**
 * React to Datatruck load posts and roast failure messages in driver groups.
 */
const config = require('../config/config');
const db = require('../database/db');
const { safeSend } = require('./telegramHtml');
const { normalizeUsername, isDatatruckPeerUser, isDatatruckFailureMessage, isDatatruckLoadMessage } = require('./datatruckPeerPatterns');
const { generateDatatruckBanterMessage } = require('./datatruckBanterMessage');

const ONE_HOUR_MS = 60 * 60 * 1000;
const DEDUP_TTL_MS = 24 * ONE_HOUR_MS;

/** @type {Map<string, number[]>} */
const actionTimestampsByChat = new Map();
/** @type {Map<string, { text: string, at: number }[]>} */
const recentBanterByChat = new Map();

function isGroupChat(ctx) {
  const chatType = ctx.chat?.type;
  return chatType === 'group' || chatType === 'supergroup';
}

function getMessageText(ctx) {
  return String(ctx.message?.text || ctx.message?.caption || '').trim();
}

function isReplyToWenze(ctx, wenzeUsername) {
  const replyFrom = ctx.message?.reply_to_message?.from;
  if (!replyFrom?.is_bot) return false;
  const wenze = normalizeUsername(wenzeUsername);
  if (!wenze) return false;
  return normalizeUsername(replyFrom.username) === wenze;
}

function pruneTimestamps(chatId, now = Date.now()) {
  const key = String(chatId);
  const existing = actionTimestampsByChat.get(key) || [];
  const fresh = existing.filter((ts) => now - ts < ONE_HOUR_MS);
  if (fresh.length) actionTimestampsByChat.set(key, fresh);
  else actionTimestampsByChat.delete(key);
  return fresh;
}

function isRateLimited(chatId, now = Date.now()) {
  const fresh = pruneTimestamps(chatId, now);
  return fresh.length >= config.datatruckBanterMaxPerHourPerChat;
}

function recordAction(chatId, now = Date.now()) {
  const key = String(chatId);
  const fresh = pruneTimestamps(chatId, now);
  fresh.push(now);
  actionTimestampsByChat.set(key, fresh);
}

function hashBanterText(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getRecentBanterTexts(chatId, now = Date.now()) {
  const key = String(chatId);
  const existing = recentBanterByChat.get(key) || [];
  const fresh = existing.filter((entry) => now - entry.at < DEDUP_TTL_MS);
  if (fresh.length) recentBanterByChat.set(key, fresh);
  else recentBanterByChat.delete(key);
  return fresh.map((entry) => entry.text);
}

function recordBanterText(chatId, text, now = Date.now()) {
  const key = String(chatId);
  const normalized = String(text || '').trim();
  const existing = recentBanterByChat.get(key) || [];
  const fresh = existing.filter((entry) => now - entry.at < DEDUP_TTL_MS);
  fresh.push({ text: normalized, at: now });
  recentBanterByChat.set(key, fresh);
  return hashBanterText(normalized);
}

function wasBanterRecentlyUsed(chatId, text, now = Date.now()) {
  const hash = hashBanterText(text);
  return getRecentBanterTexts(chatId, now).includes(hash);
}

async function applyLoadReactions(telegram, chatId, messageId, randomFn = Math.random) {
  const reactions = [{ type: 'emoji', emoji: '👍' }];
  if (randomFn() < config.datatruckLoadFlameChance) {
    reactions.push({ type: 'emoji', emoji: '🔥' });
  }
  await telegram.callApi('setMessageReaction', {
    chat_id: chatId,
    message_id: messageId,
    reaction: reactions,
  });
}

async function sendBanterReply(telegram, chatId, messageId, text) {
  await safeSend(() => telegram.sendMessage(chatId, text, {
    reply_to_message_id: messageId,
  }));
}

/**
 * @returns {Promise<{ handled: boolean, action?: string, reason?: string }>}
 */
async function handleDatatruckPeerMessage(ctx, options = {}) {
  const randomFn = typeof options.random === 'function' ? options.random : Math.random;
  const wenzeUsername = options.wenzeUsername || ctx.me || ctx.botInfo?.username || '';

  if (!config.datatruckPeerEnabled) {
    return { handled: false, reason: 'disabled' };
  }
  if (!isGroupChat(ctx)) {
    return { handled: false, reason: 'not_group' };
  }
  if (!isDatatruckPeerUser(ctx.from, config.datatruckPeerBotUsername)) {
    return { handled: false, reason: 'not_peer_bot' };
  }
  if (isReplyToWenze(ctx, wenzeUsername)) {
    return { handled: false, reason: 'reply_to_wenze' };
  }

  const chatId = ctx.chat.id;
  const messageId = ctx.message?.message_id;
  if (!messageId) {
    return { handled: false, reason: 'no_message_id' };
  }

  const group = await db.getGroupByTelegramId(chatId);
  if (!group || group.group_type !== 'driver' || !group.active) {
    return { handled: false, reason: 'not_active_driver_group' };
  }

  if (isRateLimited(chatId)) {
    return { handled: false, reason: 'rate_limited' };
  }

  const text = getMessageText(ctx);
  const telegram = ctx.telegram;

  if (isDatatruckFailureMessage(text)) {
    const excludeTexts = getRecentBanterTexts(chatId);
    let banter = await generateDatatruckBanterMessage({
      failureSnippet: text,
      excludeTexts,
    });

    if (!banter.message || wasBanterRecentlyUsed(chatId, banter.message)) {
      banter = await generateDatatruckBanterMessage({
        failureSnippet: text,
        excludeTexts: [...excludeTexts, banter.message].filter(Boolean),
      });
    }

    if (!banter.message) {
      return { handled: false, reason: 'empty_banter' };
    }

    await sendBanterReply(telegram, chatId, messageId, banter.message);
    recordBanterText(chatId, banter.message);
    recordAction(chatId);
    console.log(`[DATATRUCK-PEER] Banter reply (${banter.provider}) in chat ${chatId}`);
    return { handled: true, action: 'banter', provider: banter.provider };
  }

  if (isDatatruckLoadMessage(text)) {
    await applyLoadReactions(telegram, chatId, messageId, randomFn);
    recordAction(chatId);
    console.log(`[DATATRUCK-PEER] Load reactions in chat ${chatId}`);
    return { handled: true, action: 'react_load' };
  }

  return { handled: false, reason: 'unclassified' };
}

function resetDatatruckPeerStateForTests() {
  actionTimestampsByChat.clear();
  recentBanterByChat.clear();
}

module.exports = {
  handleDatatruckPeerMessage,
  resetDatatruckPeerStateForTests,
  isReplyToWenze,
  isRateLimited,
  recordAction,
  applyLoadReactions,
};
