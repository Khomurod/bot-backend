/**
 * Anonymous Feedback — private-chat flow for the Wenze Feedback bot.
 *
 * When a person opens a private chat with the bot and sends "Start" (or taps
 * the Start button), the bot asks whether they are an employee or a driver,
 * then asks what their complaint / request / inquiry is about while assuring
 * them the message is 100% anonymous. Their message is relayed to the
 * anonymous feedback group WITHOUT any identifying information — no username,
 * no name, no Telegram id. Only the chosen role and the message text are sent.
 *
 * This flow is private-chat only. Group messages are never touched here, so the
 * bot continues to behave exactly as before inside groups.
 */
const { Markup } = require('telegraf');
const config = require('../config/config');
const { safeSend } = require('../services/telegramHtml');

const SESSION_TTL_MS = 30 * 60 * 1000;
const ROLE_CALLBACK_PREFIX = 'afb_role_';

const ROLES = {
  employee: 'Employee',
  driver: 'Driver',
};

// In-memory sessions keyed by the user's Telegram id. Intentionally NOT
// persisted: keeping the flow ephemeral reinforces the anonymity guarantee.
const sessions = new Map();

function isExpired(session) {
  return !session || Date.now() > session.expiresAt;
}

function getSession(userId) {
  const session = sessions.get(userId);
  if (isExpired(session)) {
    sessions.delete(userId);
    return null;
  }
  return session;
}

function setSession(userId, patch) {
  const existing = getSession(userId) || {};
  const session = {
    ...existing,
    ...patch,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(userId, session);
  return session;
}

function clearSession(userId) {
  sessions.delete(userId);
}

function isPrivateChat(ctx) {
  return ctx.chat?.type === 'private';
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function roleQuestionKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('👔 Employee', `${ROLE_CALLBACK_PREFIX}employee`),
      Markup.button.callback('🚚 Driver', `${ROLE_CALLBACK_PREFIX}driver`),
    ],
  ]);
}

/**
 * Begin (or restart) the anonymous feedback flow for a private chat.
 * Safe to call from the /start handler and from the plain-text handler.
 */
async function beginAnonymousFeedback(ctx) {
  if (!isPrivateChat(ctx) || !ctx.from?.id) return;
  setSession(ctx.from.id, { step: 'awaiting_role', role: null });
  await ctx.reply(
    '👋 Welcome to <b>Wenze Feedback</b>.\n\n'
    + 'Are you an <b>employee</b> or a <b>driver</b>?',
    { parse_mode: 'HTML', ...roleQuestionKeyboard() }
  );
}

async function handleRoleSelection(ctx) {
  try {
    if (!isPrivateChat(ctx) || !ctx.from?.id) {
      await ctx.answerCbQuery();
      return;
    }
    const roleKey = ctx.match[1];
    const roleLabel = ROLES[roleKey];
    if (!roleLabel) {
      await ctx.answerCbQuery('Please choose Employee or Driver.');
      return;
    }

    setSession(ctx.from.id, { step: 'awaiting_description', role: roleLabel });
    await ctx.answerCbQuery();
    // Remove the buttons so the choice can't be re-tapped, but keep the text.
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch (_) { /* message may be too old to edit; ignore */ }

    await ctx.reply(
      `Thank you. You're sending feedback as a <b>${escapeHtml(roleLabel)}</b>.\n\n`
      + 'What is your <b>complaint, request, or inquiry</b> about? '
      + 'Just type your message below.\n\n'
      + '🔒 <b>Your message is 100% anonymous.</b> Your name, username, and Telegram '
      + 'account are never shared — we only see the message itself.',
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.error('[ANON-FEEDBACK] Role selection failed:', err.message);
    try { await ctx.answerCbQuery('Something went wrong. Send /start to try again.'); } catch (_) { /* ignore */ }
  }
}

async function relayAnonymousMessage(ctx, session, messageText) {
  const groupId = config.anonymousFeedbackGroupId;
  if (!groupId) {
    console.warn('[ANON-FEEDBACK] anonymousFeedbackGroupId is not configured; cannot relay message.');
    await ctx.reply('Sorry, anonymous feedback is not available right now. Please try again later.');
    return;
  }

  // IMPORTANT: deliberately build the relayed message from ONLY the role and
  // the message text. No username, first/last name, or Telegram id is ever
  // included, so the message is truly anonymous.
  const body = [
    '📩 <b>New Anonymous Feedback</b>',
    '',
    `👤 From: <b>${escapeHtml(session.role || 'Unknown')}</b>`,
    '',
    `💬 ${escapeHtml(messageText)}`,
  ].join('\n');

  await safeSend(() => ctx.telegram.sendMessage(groupId, body, { parse_mode: 'HTML' }));

  clearSession(ctx.from.id);
  await ctx.reply(
    '✅ Your message has been sent <b>anonymously</b>. Thank you for reaching out — '
    + 'your identity was not included.\n\n'
    + 'Send /start anytime to submit another anonymous message.',
    { parse_mode: 'HTML' }
  );
}

/**
 * Private-chat text handler. Returns true if it handled the message (so the
 * caller should stop), false if the message should fall through to other
 * handlers / be ignored by this feature.
 */
async function handlePrivateText(ctx) {
  if (!isPrivateChat(ctx) || !ctx.from?.id) return false;

  const rawText = typeof ctx.message?.text === 'string'
    ? ctx.message.text
    : (typeof ctx.message?.caption === 'string' ? ctx.message.caption : '');
  const text = rawText.trim();

  // Slash commands (e.g. /start, /cancel) are handled by their own handlers.
  if (text.startsWith('/')) return false;

  const session = getSession(ctx.from.id);

  if (session?.step === 'awaiting_description') {
    if (!text) {
      await ctx.reply('Please type your message as text so it can be relayed anonymously.');
      return true;
    }
    await relayAnonymousMessage(ctx, session, text);
    return true;
  }

  if (session?.step === 'awaiting_role') {
    // They typed instead of tapping a button — re-show the choice.
    await ctx.reply(
      'Please choose whether you are an <b>employee</b> or a <b>driver</b>.',
      { parse_mode: 'HTML', ...roleQuestionKeyboard() }
    );
    return true;
  }

  // No active session: any private message starts the anonymous flow.
  await beginAnonymousFeedback(ctx);
  return true;
}

function registerAnonymousFeedbackHandlers(bot) {
  bot.action(new RegExp(`^${ROLE_CALLBACK_PREFIX}(employee|driver)$`), handleRoleSelection);

  bot.command('cancel', async (ctx, next) => {
    if (!isPrivateChat(ctx) || !ctx.from?.id) {
      if (typeof next === 'function') return next();
      return;
    }
    const session = getSession(ctx.from.id);
    if (!session) {
      if (typeof next === 'function') return next();
      return;
    }
    clearSession(ctx.from.id);
    await ctx.reply('Cancelled. Send /start whenever you want to leave anonymous feedback.');
  });

  bot.on('text', async (ctx, next) => {
    try {
      const handled = await handlePrivateText(ctx);
      if (!handled && typeof next === 'function') return next();
    } catch (err) {
      console.error('[ANON-FEEDBACK] text handler failed:', err.message);
      try {
        await ctx.reply('Something went wrong. Send /start to begin again.');
      } catch (_) { /* ignore */ }
    }
  });

  console.log('[ANON-FEEDBACK] Anonymous feedback handlers registered.');
}

module.exports = {
  ROLE_CALLBACK_PREFIX,
  ROLES,
  SESSION_TTL_MS,
  beginAnonymousFeedback,
  handleRoleSelection,
  handlePrivateText,
  relayAnonymousMessage,
  registerAnonymousFeedbackHandlers,
  // exposed for tests
  _sessions: sessions,
  getSession,
  clearSession,
};
