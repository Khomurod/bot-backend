/**
 * Creator-only broadcast controls for the Wenze Support Bot.
 *
 * Only the single authorized Telegram user (CREATOR_USER_ID, 2117922421) may
 * trigger a broadcast from inside Telegram. Authorization is by numeric user id
 * only (never username, which can change) and is further restricted to the
 * bot's private chat. Every other user — group admins, drivers, dispatchers —
 * is politely denied.
 *
 * The bot-side flow mirrors the admin panel's targeting: the creator picks a
 * receiver group set (all driver groups, or a single language group), then
 * sends the message text or a photo/video (with optional caption). Sending
 * reuses the shared sendBroadcastToGroups helper and the shared
 * resolveBroadcastTargetGroups targeting service, so bot-side broadcasts behave
 * exactly like admin-panel broadcasts.
 */
const { Markup } = require('telegraf');
const { CREATOR_USER_ID } = require('./creatorMessageManager');
const { resolveBroadcastTargetGroups } = require('../services/broadcastTargetService');

const SESSION_TTL_MS = 15 * 60 * 1000;

// The receiver-group presets offered inside Telegram. These map onto the same
// target_type / target_languages contract the admin broadcast API uses.
const TARGET_OPTIONS = {
  all: { label: 'All driver groups', body: { target_type: 'all' } },
  en: { label: 'English groups', body: { target_type: 'language_groups', target_languages: ['en'] } },
  ru: { label: 'Russian groups', body: { target_type: 'language_groups', target_languages: ['ru'] } },
  uz: { label: 'Uzbek groups', body: { target_type: 'language_groups', target_languages: ['uz'] } },
};

function createCreatorBroadcast({
  creatorUserId = CREATOR_USER_ID,
  sendBroadcastToGroups,
  resolveTargets = resolveBroadcastTargetGroups,
  createBroadcast = null,
  sessionTtlMs = SESSION_TTL_MS,
  now = () => Date.now(),
} = {}) {
  if (typeof sendBroadcastToGroups !== 'function') {
    throw new Error('createCreatorBroadcast requires a sendBroadcastToGroups function');
  }

  // userId -> { stage: 'awaiting_target' | 'awaiting_content', target, createdAt }
  const sessions = new Map();

  function isCreator(ctx) {
    return Number(ctx.from?.id) === Number(creatorUserId);
  }

  function isCreatorPrivate(ctx) {
    return isCreator(ctx) && ctx.chat?.type === 'private';
  }

  function pruneExpired() {
    const cutoff = now() - sessionTtlMs;
    for (const [key, session] of sessions) {
      if (session.createdAt < cutoff) sessions.delete(key);
    }
  }

  function sessionKey(ctx) {
    return String(ctx.from?.id);
  }

  async function handleBroadcastCommand(ctx) {
    pruneExpired();
    // Authorization: numeric user id only. Deny everyone else politely.
    if (!isCreator(ctx)) {
      await ctx.reply('Sorry, broadcast controls are restricted and not available to your account.');
      return;
    }
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Please open a private chat with me to send a broadcast.');
      return;
    }

    sessions.set(sessionKey(ctx), { stage: 'awaiting_target', createdAt: now() });
    await ctx.reply(
      'Broadcast — choose which receiver groups to send to:',
      Markup.inlineKeyboard([
        [Markup.button.callback(TARGET_OPTIONS.all.label, 'bcast:t:all')],
        [
          Markup.button.callback('English', 'bcast:t:en'),
          Markup.button.callback('Russian', 'bcast:t:ru'),
          Markup.button.callback('Uzbek', 'bcast:t:uz'),
        ],
        [Markup.button.callback('Cancel', 'bcast:cancel')],
      ])
    );
  }

  async function handleTargetSelection(ctx) {
    if (!isCreatorPrivate(ctx)) {
      await ctx.answerCbQuery('Not authorized.');
      return;
    }
    pruneExpired();
    const key = ctx.match[1];
    const option = TARGET_OPTIONS[key];
    const session = sessions.get(sessionKey(ctx));
    if (!option || !session) {
      await ctx.answerCbQuery('This broadcast request expired. Send /broadcast again.');
      return;
    }

    session.stage = 'awaiting_content';
    session.target = option;
    session.createdAt = now();
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `Target: ${option.label}.\n\n`
      + 'Now send the message to broadcast — plain text, or a photo/video with an optional caption. '
      + 'Send /cancel to abort.'
    );
  }

  async function handleCancel(ctx) {
    if (!isCreatorPrivate(ctx)) {
      await ctx.answerCbQuery('Not authorized.');
      return;
    }
    sessions.delete(sessionKey(ctx));
    await ctx.answerCbQuery('Cancelled.');
    await ctx.editMessageText('Broadcast cancelled.');
  }

  // Extract broadcast payload from a Telegram message: text, or media + caption.
  function extractPayload(message) {
    const caption = typeof message.caption === 'string' ? message.caption : '';
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      // Highest-resolution photo size is last.
      const largest = message.photo[message.photo.length - 1];
      return { mediaItems: [{ file_id: largest.file_id, media_type: 'photo' }], text: caption };
    }
    if (message.video && message.video.file_id) {
      return { mediaItems: [{ file_id: message.video.file_id, media_type: 'video' }], text: caption };
    }
    if (typeof message.text === 'string' && message.text.trim()) {
      return { mediaItems: null, text: message.text };
    }
    return null;
  }

  async function handleContent(ctx, next) {
    try {
      pruneExpired();
      // Only intercept the authorized creator's private messages mid-broadcast;
      // everything else falls straight through to existing handlers.
      if (!isCreatorPrivate(ctx)) return next();
      const session = sessions.get(sessionKey(ctx));
      if (!session || session.stage !== 'awaiting_content') return next();

      const message = ctx.message;
      if (!message) return next();

      if (typeof message.text === 'string' && message.text.trim() === '/cancel') {
        sessions.delete(sessionKey(ctx));
        await ctx.reply('Broadcast cancelled.');
        return;
      }

      const payload = extractPayload(message);
      if (!payload) {
        await ctx.reply('Send plain text, a photo, or a video to broadcast. Send /cancel to abort.');
        return;
      }

      // Consume the session before the (slow) send so a double-send is impossible.
      sessions.delete(sessionKey(ctx));

      let groups;
      try {
        groups = await resolveTargets(session.target.body);
      } catch (err) {
        console.error('[CREATOR-BROADCAST] Failed to resolve target groups:', err.message);
        await ctx.reply('Could not load the target groups right now. Please try again in a moment.');
        return;
      }
      if (!groups || groups.length === 0) {
        await ctx.reply('No active groups matched that target, so nothing was sent.');
        return;
      }

      await ctx.reply(`Sending to ${groups.length} group(s)…`);

      let broadcastId = null;
      if (typeof createBroadcast === 'function') {
        try {
          const record = await createBroadcast({
            type: 'regular',
            message_text_en: payload.text || null,
            message_text_ru: null,
            message_text_uz: null,
            media_items: payload.mediaItems,
            media_position: 'above',
            parse_mode: 'HTML',
            target_type: session.target.body.target_type,
            target_driver_ids: null,
            target_languages: session.target.body.target_languages || null,
            force_language: null,
            target_active_filter: 'active',
          });
          broadcastId = record?.id ?? null;
        } catch (err) {
          // Audit record is best-effort; never block the actual send on it.
          console.error('[CREATOR-BROADCAST] Could not persist broadcast record:', err.message);
        }
      }

      try {
        const results = await sendBroadcastToGroups(
          groups,
          payload.text || '',
          undefined, // plain text — do not interpret creator input as HTML/Markdown
          null,
          payload.mediaItems,
          'above',
          broadcastId,
          null,
          { enablePlaceholders: false }
        );
        const errorNote = results.failed > 0 && results.errors?.length
          ? `\nFirst error: ${results.errors[0].error}`
          : '';
        await ctx.reply(`Broadcast complete. Sent: ${results.sent}, Failed: ${results.failed}.${errorNote}`);
      } catch (err) {
        console.error('[CREATOR-BROADCAST] Broadcast send failed:', err.message);
        await ctx.reply(`Broadcast failed: ${err.message}`);
      }
    } catch (err) {
      console.error('[CREATOR-BROADCAST] Unexpected error handling broadcast content:', err.message);
      return next();
    }
  }

  return {
    handleBroadcastCommand,
    handleTargetSelection,
    handleCancel,
    handleContent,
    isCreator,
    isCreatorPrivate,
    sessions,
  };
}

function registerCreatorBroadcast(bot, options = {}) {
  const manager = createCreatorBroadcast(options);
  bot.command('broadcast', manager.handleBroadcastCommand);
  bot.action(/^bcast:t:(all|en|ru|uz)$/, manager.handleTargetSelection);
  bot.action(/^bcast:cancel$/, manager.handleCancel);
  // Registered as a message middleware; it no-ops (calls next) unless the
  // authorized creator is mid-broadcast, so it never disturbs other handlers.
  bot.on('message', manager.handleContent);
  console.log('[CREATOR-BROADCAST] Creator-only broadcast handlers registered.');
  return manager;
}

module.exports = {
  TARGET_OPTIONS,
  SESSION_TTL_MS,
  createCreatorBroadcast,
  registerCreatorBroadcast,
};
