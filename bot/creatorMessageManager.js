const crypto = require('crypto');
const { Markup } = require('telegraf');
const db = require('../database/db');
const { resolveForwardedBotMessage } = require('../services/botSentMessageRegistry');

const CREATOR_USER_ID = 2117922421;
const SESSION_TTL_MS = 15 * 60 * 1000;

function targetLabel(target) {
  return target.chat_title || `chat ${target.telegram_chat_id}`;
}

function targetPreview(target) {
  const text = String(target.message_text || '').replace(/\s+/g, ' ').trim();
  if (!text) return '(media message without text)';
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function createCreatorMessageManager({
  database = db,
  creatorUserId = CREATOR_USER_ID,
  sessionTtlMs = SESSION_TTL_MS,
  now = () => Date.now(),
  createToken = () => crypto.randomBytes(8).toString('hex'),
} = {}) {
  const sessions = new Map();
  const pendingEdits = new Map();

  function isCreatorPrivateContext(ctx) {
    return Number(ctx.from?.id) === Number(creatorUserId) && ctx.chat?.type === 'private';
  }

  function pruneExpired() {
    const cutoff = now() - sessionTtlMs;
    for (const [token, session] of sessions) {
      if (session.createdAt < cutoff) sessions.delete(token);
    }
    for (const [key, edit] of pendingEdits) {
      if (edit.createdAt < cutoff) pendingEdits.delete(key);
    }
  }

  function editKey(ctx) {
    return `${ctx.chat?.id}:${ctx.from?.id}`;
  }

  function getSession(ctx, token) {
    pruneExpired();
    const session = sessions.get(token);
    if (!session || Number(session.ownerId) !== Number(ctx.from?.id)) return null;
    return session;
  }

  async function handleForward(ctx, next) {
    pruneExpired();
    const message = ctx.message;
    if (!message || !isCreatorPrivateContext(ctx)) return next();

    const key = editKey(ctx);
    const pending = pendingEdits.get(key);
    if (pending) {
      if (message.text === '/cancel') {
        pendingEdits.delete(key);
        await ctx.reply('Edit cancelled.');
        return;
      }

      if (
        message.forward_origin
        || message.forward_from
        || message.forward_from_chat
        || Number.isFinite(message.forward_date)
      ) {
        await ctx.reply('Send new replacement text, not another forwarded message, or /cancel.');
        return;
      }

      const replacement = typeof message.text === 'string'
        ? message.text
        : (typeof message.caption === 'string' ? message.caption : null);
      if (replacement == null) {
        await ctx.reply('Send replacement text, or /cancel.');
        return;
      }

      const maxLength = pending.target.content_kind === 'caption' ? 1024 : 4096;
      if (replacement.length > maxLength) {
        await ctx.reply(`That text is too long. The limit is ${maxLength} characters.`);
        return;
      }

      try {
        const chatId = pending.target.telegram_chat_id;
        const messageId = Number(pending.target.telegram_message_id);
        const entities = message.entities || message.caption_entities || undefined;

        if (pending.target.content_kind === 'caption') {
          await ctx.telegram.editMessageCaption(
            chatId,
            messageId,
            undefined,
            replacement,
            entities ? { caption_entities: entities } : {}
          );
        } else if (pending.target.content_kind === 'text') {
          await ctx.telegram.editMessageText(
            chatId,
            messageId,
            undefined,
            replacement,
            entities ? { entities } : {}
          );
        } else {
          pendingEdits.delete(key);
          await ctx.reply('This message type cannot be edited safely. It can still be deleted.');
          return;
        }

        await database.updateBotSentMessageContent(
          chatId,
          String(messageId),
          replacement,
          pending.target.content_kind
        );
        pendingEdits.delete(key);
        await ctx.reply(`Message edited in ${targetLabel(pending.target)}.`);
      } catch (err) {
        console.error('[CREATOR-MESSAGE-MANAGER] Edit failed:', err.message);
        await ctx.reply(`Telegram could not edit that message: ${err.message}`);
      }
      return;
    }

    const resolved = await resolveForwardedBotMessage(message, {
      db: database,
      botInfo: ctx.botInfo,
    });
    if (resolved.status === 'not_forwarded') return next();

    if (resolved.status !== 'resolved') {
      const reason = resolved.status === 'ambiguous'
        ? 'More than one sent message matched this forward.'
        : 'I could not safely identify the original Wenze Feedback message.';
      await ctx.reply(`${reason} No action was taken.`);
      return;
    }

    const token = createToken();
    sessions.set(token, {
      ownerId: ctx.from.id,
      target: resolved.target,
      createdAt: now(),
    });

    await ctx.reply(
      `Manage this message in ${targetLabel(resolved.target)}:\n\n${targetPreview(resolved.target)}`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('Edit', `mm:e:${token}`),
          Markup.button.callback('Delete', `mm:d:${token}`),
        ],
        [Markup.button.callback('Cancel', `mm:c:${token}`)],
      ])
    );
  }

  async function handleEditAction(ctx) {
    if (!isCreatorPrivateContext(ctx)) {
      await ctx.answerCbQuery('Not authorized.');
      return;
    }
    const token = ctx.match[1];
    const session = getSession(ctx, token);
    if (!session) {
      await ctx.answerCbQuery('This request expired.');
      return;
    }

    sessions.delete(token);
    pendingEdits.set(editKey(ctx), {
      ownerId: ctx.from.id,
      target: session.target,
      createdAt: now(),
    });
    await ctx.answerCbQuery();
    await ctx.reply(
      `Send the replacement text for the message in ${targetLabel(session.target)}. `
      + 'Send /cancel to stop.',
      Markup.forceReply()
    );
  }

  async function handleDeleteAction(ctx) {
    if (!isCreatorPrivateContext(ctx)) {
      await ctx.answerCbQuery('Not authorized.');
      return;
    }
    const session = getSession(ctx, ctx.match[1]);
    if (!session) {
      await ctx.answerCbQuery('This request expired.');
      return;
    }

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `Delete this message from ${targetLabel(session.target)}?\n\n${targetPreview(session.target)}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('Confirm delete', `mm:x:${ctx.match[1]}`)],
        [Markup.button.callback('Cancel', `mm:c:${ctx.match[1]}`)],
      ])
    );
  }

  async function handleDeleteConfirm(ctx) {
    if (!isCreatorPrivateContext(ctx)) {
      await ctx.answerCbQuery('Not authorized.');
      return;
    }
    const token = ctx.match[1];
    const session = getSession(ctx, token);
    if (!session) {
      await ctx.answerCbQuery('This request expired.');
      return;
    }

    await ctx.answerCbQuery('Deleting...');
    try {
      await ctx.telegram.deleteMessage(
        session.target.telegram_chat_id,
        Number(session.target.telegram_message_id)
      );
      await database.markBotSentMessageDeleted(
        session.target.telegram_chat_id,
        session.target.telegram_message_id
      );
      sessions.delete(token);
      await ctx.editMessageText(
        `Message deleted from ${targetLabel(session.target)}. `
        + 'Scheduled birthday run history was not changed.'
      );
    } catch (err) {
      console.error('[CREATOR-MESSAGE-MANAGER] Delete failed:', err.message);
      await ctx.editMessageText(
        `Telegram could not delete that message: ${err.message}`,
        Markup.inlineKeyboard([
          [Markup.button.callback('Retry delete', `mm:x:${token}`)],
          [Markup.button.callback('Cancel', `mm:c:${token}`)],
        ])
      );
    }
  }

  async function handleCancel(ctx) {
    if (!isCreatorPrivateContext(ctx)) {
      await ctx.answerCbQuery('Not authorized.');
      return;
    }
    sessions.delete(ctx.match[1]);
    await ctx.answerCbQuery('Cancelled.');
    await ctx.editMessageText('Message action cancelled.');
  }

  return {
    handleCancel,
    handleDeleteAction,
    handleDeleteConfirm,
    handleEditAction,
    handleForward,
    pendingEdits,
    sessions,
  };
}

function registerCreatorMessageManager(bot, options = {}) {
  const manager = createCreatorMessageManager(options);
  bot.on('message', manager.handleForward);
  bot.action(/^mm:e:([a-f0-9]+)$/, manager.handleEditAction);
  bot.action(/^mm:d:([a-f0-9]+)$/, manager.handleDeleteAction);
  bot.action(/^mm:x:([a-f0-9]+)$/, manager.handleDeleteConfirm);
  bot.action(/^mm:c:([a-f0-9]+)$/, manager.handleCancel);
  console.log('[CREATOR-MESSAGE-MANAGER] Creator-only edit/delete handlers registered.');
  return manager;
}

module.exports = {
  CREATOR_USER_ID,
  createCreatorMessageManager,
  registerCreatorMessageManager,
};
