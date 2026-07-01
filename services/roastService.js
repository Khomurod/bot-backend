/**
 * "Roast" feature — in one configured employee group, the bot fires back an
 * AI-written, witty (never rude) Uzbek reply whenever someone replies to one
 * of its messages or @-mentions it. Reactive only: the bot never starts a
 * roast on its own, except via the admin panel's manual "send now" action.
 */
const db = require('../database/db');
const { safeSend } = require('./telegramHtml');
const {
  isGroupChat,
  isRoastTrigger,
  isFromTargetUser,
} = require('./roastPatterns');
const { generateRoastMessage, generateManualRoastMessage } = require('./roastMessage');

const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_ROASTS_PER_HOUR_PER_CHAT = Math.max(
  1,
  parseInt(process.env.ROAST_MAX_PER_HOUR_PER_CHAT || '15', 10) || 15
);

/** @type {Map<string, number[]>} */
const roastTimestampsByChat = new Map();

function pruneTimestamps(chatId, now = Date.now()) {
  const key = String(chatId);
  const existing = roastTimestampsByChat.get(key) || [];
  const fresh = existing.filter((ts) => now - ts < ONE_HOUR_MS);
  if (fresh.length) roastTimestampsByChat.set(key, fresh);
  else roastTimestampsByChat.delete(key);
  return fresh;
}

function isRateLimited(chatId, now = Date.now()) {
  return pruneTimestamps(chatId, now).length >= MAX_ROASTS_PER_HOUR_PER_CHAT;
}

function recordRoast(chatId, now = Date.now()) {
  const key = String(chatId);
  const fresh = pruneTimestamps(chatId, now);
  fresh.push(now);
  roastTimestampsByChat.set(key, fresh);
}

function getMessageText(message) {
  return String(message?.text || message?.caption || '').trim();
}

function displayNameFor(from) {
  if (!from) return null;
  if (from.username) return `@${from.username}`;
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || null;
}

async function sendRoastReply(telegram, chatId, messageId, text) {
  await safeSend(() => telegram.sendMessage(chatId, text, {
    reply_to_message_id: messageId,
  }));
}

/**
 * @returns {Promise<{ handled: boolean, reason?: string, provider?: string }>}
 */
async function handleRoastMessage(ctx) {
  const chat = ctx.chat;
  const message = ctx.message;
  const from = ctx.from;

  if (!isGroupChat(chat) || !message) return { handled: false, reason: 'not_group' };
  if (from?.is_bot) return { handled: false, reason: 'from_bot' };

  const settings = await db.getRoastSettings();
  const inConfiguredGroup = settings?.group_id != null && String(chat.id) === String(settings.group_id);
  if (!inConfiguredGroup) return { handled: false, reason: 'wrong_group' };

  if (!settings.enabled) {
    // Logged (not silently swallowed) because this is the one group where an
    // admin expects a reply — an unexpectedly-off toggle should be visible in
    // server logs, not just a silent no-op.
    console.log(`[ROAST] Skipped in chat ${chat.id}: feature is disabled in admin settings.`);
    return { handled: false, reason: 'disabled' };
  }

  const botId = ctx.botInfo?.id;
  const botUsername = ctx.botInfo?.username || ctx.me;
  if (!isRoastTrigger(message, { botId, botUsername })) {
    return { handled: false, reason: 'not_a_trigger' };
  }

  if (isRateLimited(chat.id)) {
    console.log(`[ROAST] Skipped in chat ${chat.id}: hourly rate limit reached.`);
    return { handled: false, reason: 'rate_limited' };
  }

  const isTarget = isFromTargetUser(from, settings.target_username);
  const triggerText = getMessageText(message);

  const roast = await generateRoastMessage({
    triggerText,
    isTarget,
    displayName: displayNameFor(from),
    aiInstructions: settings.ai_instructions,
  });

  if (!roast.message) return { handled: false, reason: 'empty_roast' };

  await sendRoastReply(ctx.telegram, chat.id, message.message_id, roast.message);
  recordRoast(chat.id);
  console.log(`[ROAST] Reply (${roast.provider}) in chat ${chat.id} to ${displayNameFor(from) || 'unknown'}`);
  return { handled: true, provider: roast.provider };
}

/** Admin-triggered manual roast, tagging the configured target user. */
async function sendManualRoast(telegram) {
  const settings = await db.getRoastSettings();
  if (!settings?.group_id) throw new Error('Roast group is not configured');

  const roast = await generateManualRoastMessage({ aiInstructions: settings.ai_instructions });
  if (!roast.message) throw new Error('Failed to generate a roast message');

  const mention = `@${settings.target_username}`;
  const text = `${mention} ${roast.message}`;
  await safeSend(() => telegram.sendMessage(settings.group_id, text));
  return { sent: true, provider: roast.provider, message: text };
}

function resetRoastStateForTests() {
  roastTimestampsByChat.clear();
}

module.exports = {
  handleRoastMessage,
  sendManualRoast,
  isRateLimited,
  recordRoast,
  resetRoastStateForTests,
};
