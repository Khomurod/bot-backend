/**
 * Creator-only control panel for the Wenze Support Bot.
 *
 * Only the single authorized Telegram user (CREATOR_USER_ID, 2117922421) may
 * use these controls, and only inside the bot's private chat. Authorization is
 * by numeric user id only (never username, which can change). Every other user
 * — group admins, drivers, dispatchers — is politely denied.
 *
 * The panel exposes exactly two actions:
 *
 *   📢 Send Broadcast Message — pick one audience (active drivers, English /
 *      Russian / Uzbek drivers, all groups, the employee group, or other
 *      company groups), then send ANY message. It is delivered to every group
 *      in that audience in its exact original format.
 *
 *   ✉️ Send Single Message — search for one specific group by name, pick it,
 *      then send ANY message to just that group.
 *
 * Delivery uses Telegram's copyMessage, so whatever the creator sends — plain
 * text, photo, video, document, audio, voice, animation, an album is copied
 * verbatim (same media, same caption, same formatting) with no "forwarded from"
 * header. That is what "forward it in the precise format" means here.
 */
const { Markup } = require('telegraf');
const db = require('../database/db');
const { CREATOR_USER_ID } = require('./creatorMessageManager');
const { resolveBroadcastTargetGroups } = require('../services/broadcastTargetService');

const SESSION_TTL_MS = 15 * 60 * 1000;
// Small gap between per-group copies to stay well under Telegram's ~30 msg/s
// bulk limit. Injectable so tests run with no delay.
const DEFAULT_SEND_DELAY_MS = 45;
const MAX_SINGLE_RESULTS = 8;

// The broadcast audiences. Each maps onto the same target_type / target_languages
// / target_active_filter contract the admin panel and scheduler already use, so
// bot-side broadcasts resolve to identical group sets.
const TARGET_OPTIONS = {
  active: { label: '🚚 Active drivers', body: { target_type: 'all', target_active_filter: 'active' } },
  en: { label: '🇺🇸 English drivers', body: { target_type: 'language_groups', target_languages: ['en'], target_active_filter: 'active' } },
  ru: { label: '🇷🇺 Russian drivers', body: { target_type: 'language_groups', target_languages: ['ru'], target_active_filter: 'active' } },
  uz: { label: '🇺🇿 Uzbek drivers', body: { target_type: 'language_groups', target_languages: ['uz'], target_active_filter: 'active' } },
  all: { label: '🌐 All groups', body: { target_type: 'all', target_active_filter: 'all' } },
  employee: { label: '🧑‍💼 Employee group', body: { target_type: 'employee', target_active_filter: 'active' } },
  company: { label: '🏢 Other company groups', body: { target_type: 'other_company', target_active_filter: 'active' } },
};

const TARGET_KEYS = Object.keys(TARGET_OPTIONS);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createCreatorControlPanel({
  creatorUserId = CREATOR_USER_ID,
  database = db,
  resolveTargets = resolveBroadcastTargetGroups,
  sessionTtlMs = SESSION_TTL_MS,
  sendDelayMs = DEFAULT_SEND_DELAY_MS,
  now = () => Date.now(),
} = {}) {
  // userId -> { stage, target?, groupTarget?, createdAt }
  //   stage: 'awaiting_single_query' | 'awaiting_broadcast_content' | 'awaiting_single_content'
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

  function menuKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('📢 Send Broadcast Message', 'cpanel:broadcast')],
      [Markup.button.callback('✉️ Send Single Message', 'cpanel:single')],
    ]);
  }

  function targetKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback(TARGET_OPTIONS.active.label, 'cpanel:t:active')],
      [
        Markup.button.callback('🇺🇸 English', 'cpanel:t:en'),
        Markup.button.callback('🇷🇺 Russian', 'cpanel:t:ru'),
        Markup.button.callback('🇺🇿 Uzbek', 'cpanel:t:uz'),
      ],
      [Markup.button.callback(TARGET_OPTIONS.all.label, 'cpanel:t:all')],
      [Markup.button.callback(TARGET_OPTIONS.employee.label, 'cpanel:t:employee')],
      [Markup.button.callback(TARGET_OPTIONS.company.label, 'cpanel:t:company')],
      [Markup.button.callback('✖️ Cancel', 'cpanel:cancel')],
    ]);
  }

  // ─── Menu entry ───

  async function handleMenuCommand(ctx) {
    pruneExpired();
    if (!isCreator(ctx)) {
      await ctx.reply('Sorry, these controls are restricted and not available to your account.');
      return;
    }
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Please open a private chat with me to use the messaging panel.');
      return;
    }
    // Opening the panel resets any half-finished flow.
    sessions.delete(sessionKey(ctx));
    await ctx.reply('What would you like to do?', menuKeyboard());
  }

  async function handlePickBroadcast(ctx) {
    if (!isCreatorPrivate(ctx)) {
      await ctx.answerCbQuery('Not authorized.');
      return;
    }
    pruneExpired();
    await ctx.answerCbQuery();
    await ctx.editMessageText('📢 Broadcast — choose the audience:', targetKeyboard());
  }

  async function handlePickSingle(ctx) {
    if (!isCreatorPrivate(ctx)) {
      await ctx.answerCbQuery('Not authorized.');
      return;
    }
    pruneExpired();
    sessions.set(sessionKey(ctx), { stage: 'awaiting_single_query', createdAt: now() });
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      '✉️ Single message — type part of the group\'s name to find it '
      + '(for example a unit number or driver name). Send /cancel to abort.'
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
    if (!option) {
      await ctx.answerCbQuery('Unknown audience.');
      return;
    }
    sessions.set(sessionKey(ctx), {
      stage: 'awaiting_broadcast_content',
      target: option,
      createdAt: now(),
    });
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `Audience: ${option.label}.\n\n`
      + 'Now send the message to broadcast — text, photo, video, document, or any '
      + 'other content. It is delivered exactly as you send it. Send /cancel to abort.'
    );
  }

  async function handleGroupPick(ctx) {
    if (!isCreatorPrivate(ctx)) {
      await ctx.answerCbQuery('Not authorized.');
      return;
    }
    pruneExpired();
    const groupId = Number(ctx.match[1]);
    let group;
    try {
      group = await database.getGroupByIdAnyType(groupId);
    } catch (err) {
      console.error('[CREATOR-PANEL] Failed to load picked group:', err.message);
    }
    if (!group) {
      await ctx.answerCbQuery('That group is no longer available.');
      return;
    }
    sessions.set(sessionKey(ctx), {
      stage: 'awaiting_single_content',
      groupTarget: group,
      createdAt: now(),
    });
    await ctx.answerCbQuery();
    const title = group.group_name || `chat ${group.telegram_group_id}`;
    await ctx.editMessageText(
      `Target: ${title}.\n\n`
      + 'Now send the message — text, photo, video, document, or any other content. '
      + 'It is delivered exactly as you send it. Send /cancel to abort.'
    );
  }

  async function handleCancel(ctx) {
    if (!isCreatorPrivate(ctx)) {
      await ctx.answerCbQuery('Not authorized.');
      return;
    }
    sessions.delete(sessionKey(ctx));
    await ctx.answerCbQuery('Cancelled.');
    await ctx.editMessageText('Cancelled.');
  }

  // ─── Delivery ───

  // Copy the creator's just-sent message verbatim into every target chat.
  async function copyToGroups(ctx, groups) {
    const fromChatId = ctx.chat.id;
    const messageId = ctx.message.message_id;
    let sent = 0;
    let failed = 0;
    const errors = [];
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i];
      try {
        await ctx.telegram.copyMessage(group.telegram_group_id, fromChatId, messageId);
        sent += 1;
      } catch (err) {
        failed += 1;
        errors.push({ group: group.group_name || group.telegram_group_id, error: err.message });
        console.error(`[CREATOR-PANEL] copyMessage failed for ${group.group_name || group.telegram_group_id}:`, err.message);
      }
      if (sendDelayMs > 0 && i < groups.length - 1) await sleep(sendDelayMs);
    }
    return { sent, failed, errors };
  }

  function isCancel(message) {
    return typeof message.text === 'string' && message.text.trim() === '/cancel';
  }

  async function runBroadcast(ctx, session) {
    let groups;
    try {
      groups = await resolveTargets(session.target.body);
    } catch (err) {
      console.error('[CREATOR-PANEL] Failed to resolve target groups:', err.message);
      await ctx.reply('Could not load the target groups right now. Please try again in a moment.');
      return;
    }
    if (!groups || groups.length === 0) {
      await ctx.reply('No groups matched that audience, so nothing was sent.');
      return;
    }
    await ctx.reply(`Sending to ${groups.length} group(s)…`);
    const results = await copyToGroups(ctx, groups);
    const errorNote = results.failed > 0 && results.errors.length
      ? `\nFirst error: ${results.errors[0].error}`
      : '';
    await ctx.reply(`Done. Sent: ${results.sent}, Failed: ${results.failed}.${errorNote}`);
  }

  async function runSingle(ctx, session) {
    const results = await copyToGroups(ctx, [session.groupTarget]);
    const title = session.groupTarget.group_name || session.groupTarget.telegram_group_id;
    if (results.sent === 1) {
      await ctx.reply(`Sent to ${title}.`);
    } else {
      await ctx.reply(`Could not send to ${title}: ${results.errors[0]?.error || 'unknown error'}`);
    }
  }

  async function runSingleSearch(ctx, session) {
    const term = ctx.message.text.trim();
    let matches;
    try {
      matches = await database.searchGroupsByName(term, MAX_SINGLE_RESULTS);
    } catch (err) {
      console.error('[CREATOR-PANEL] Group search failed:', err.message);
      await ctx.reply('Search failed right now. Please try again in a moment.');
      return;
    }
    if (!matches || matches.length === 0) {
      await ctx.reply('No groups matched that. Type a different name, or /cancel.');
      return;
    }
    // Keep the search session open so the creator can refine before picking.
    session.createdAt = now();
    await ctx.reply(
      `Found ${matches.length} group(s). Pick one:`,
      Markup.inlineKeyboard([
        ...matches.map((g) => [Markup.button.callback(
          `${g.group_name || g.telegram_group_id}${g.active === false ? ' (inactive)' : ''}`,
          `cpanel:sg:${g.id}`,
        )]),
        [Markup.button.callback('✖️ Cancel', 'cpanel:cancel')],
      ])
    );
  }

  // Message middleware. No-ops (calls next) unless the authorized creator is
  // mid-flow, so it never disturbs any other handler.
  async function handleContent(ctx, next) {
    try {
      pruneExpired();
      if (!isCreatorPrivate(ctx)) return next();
      const session = sessions.get(sessionKey(ctx));
      if (!session) return next();

      const message = ctx.message;
      if (!message) return next();

      if (isCancel(message)) {
        sessions.delete(sessionKey(ctx));
        await ctx.reply('Cancelled.');
        return;
      }

      if (session.stage === 'awaiting_single_query') {
        if (typeof message.text !== 'string' || !message.text.trim()) {
          await ctx.reply('Type part of the group\'s name to find it, or /cancel.');
          return;
        }
        await runSingleSearch(ctx, session);
        return;
      }

      if (session.stage === 'awaiting_broadcast_content') {
        // Consume before the (slow) send so a double-send is impossible.
        sessions.delete(sessionKey(ctx));
        await runBroadcast(ctx, session);
        return;
      }

      if (session.stage === 'awaiting_single_content') {
        sessions.delete(sessionKey(ctx));
        await runSingle(ctx, session);
        return;
      }

      return next();
    } catch (err) {
      console.error('[CREATOR-PANEL] Unexpected error handling content:', err.message);
      return next();
    }
  }

  return {
    handleMenuCommand,
    handlePickBroadcast,
    handlePickSingle,
    handleTargetSelection,
    handleGroupPick,
    handleCancel,
    handleContent,
    isCreator,
    isCreatorPrivate,
    sessions,
  };
}

function registerCreatorControlPanel(bot, options = {}) {
  const panel = createCreatorControlPanel(options);

  // The panel opens from /panel, and — for the creator only — also from
  // /broadcast (muscle memory) and /start. For everyone else /start falls
  // through to the normal private-chat behavior via next().
  bot.command('panel', panel.handleMenuCommand);
  bot.command('broadcast', panel.handleMenuCommand);
  bot.start(async (ctx, next) => {
    if (panel.isCreatorPrivate(ctx)) {
      await panel.handleMenuCommand(ctx);
      return;
    }
    return next();
  });

  bot.action('cpanel:broadcast', panel.handlePickBroadcast);
  bot.action('cpanel:single', panel.handlePickSingle);
  bot.action(/^cpanel:t:(active|en|ru|uz|all|employee|company)$/, panel.handleTargetSelection);
  bot.action(/^cpanel:sg:(\d+)$/, panel.handleGroupPick);
  bot.action('cpanel:cancel', panel.handleCancel);

  // Registered as message middleware; no-ops unless the creator is mid-flow.
  bot.on('message', panel.handleContent);

  console.log('[CREATOR-PANEL] Creator-only control panel registered.');
  return panel;
}

module.exports = {
  TARGET_OPTIONS,
  TARGET_KEYS,
  SESSION_TTL_MS,
  createCreatorControlPanel,
  registerCreatorControlPanel,
};
