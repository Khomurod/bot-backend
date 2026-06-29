const { Telegraf, Markup } = require('telegraf');
const config = require('../config/config');
const db = require('../database/db');
const { safeSend, isPermanentSendError: isPermanentSendErrorFromHtml } = require('../services/telegramHtml');
const { normalizeMediaItems } = require('../services/scheduledMessageUtils');
const { resolveLiveLocationForGroupTitle } = require('../services/liveLocationResolver');
const {
  buildLocationSummaryLines,
  buildStrictMismatchBlockMessage,
  isLocationDriverNameStrict,
} = require('../services/driverGroupTitle');
const {
  triggerDispatchEtaNowByGroupId,
  NO_CURRENT_LOAD_INFO_MESSAGE,
} = require('../services/dispatchEtaUpdateService');
const { runStatusSnapshotDetached } = require('../services/statusSnapshotDetached');
const {
  buildBroadcastTemplateContext,
  renderBroadcastTemplateStrict,
} = require('../services/broadcastTemplateService');
const {
  isDispatchEtaTestHub,
  handleTestHubStatusCommand,
  registerDispatchStatusLookupHandlers,
} = require('./dispatchStatusLookupHandlers');
const { scheduleLoadIngest } = require('../services/loadIngestionService');
const { handleDriverGroupStatus } = require('../services/homeTimeService');
const recentMessageBuffer = require('../services/recentMessageBuffer');
const { handleApproverMention, handleHomeTimeDateReply } = require('../services/homeTimeRequestService');
const { messageMentionsApprovers } = require('../services/homeTimeRequestConstants');
const { registerHomeTimeRequestHandlers } = require('./homeTimeRequestHandlers');
const { confirmAdminGrant } = require('../services/groupAccessService');
const { readLoadContextWithFallbacks } = require('../services/dispatchPinnedContextService');
const { registerDatatruckPeerHandlers } = require('./datatruckPeerHandlers');
const { registerMileageBonusHandlers } = require('./mileageBonusHandlers');
const { registerCreatorMessageManager } = require('./creatorMessageManager');
const { installBotSentMessageTracking } = require('../services/botSentMessageRegistry');
// config.js already validates DATABASE_URL, MANAGEMENT_GROUP_ID (BOT_TOKEN has a code default)
// and exits on missing values — no need to re-check here.

const bot = new Telegraf(config.botToken);
installBotSentMessageTracking(bot.telegram, db);
// #region agent log
function debugLog(location, message, data, hypothesisId) {
  fetch('http://127.0.0.1:7869/ingest/5069c10b-4d7b-4b84-95eb-05813bc92a8b', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'b5ce42' },
    body: JSON.stringify({
      sessionId: 'b5ce42',
      location,
      message,
      data,
      timestamp: Date.now(),
      hypothesisId,
      runId: 'pre-fix',
    }),
  }).catch(() => {});
}
// #endregion
const MANAGEMENT_GROUP_ID = config.managementGroupId;
const BOT_LAUNCH_RETRY_MS = 5000;
const BOT_LAUNCH_MAX_RETRY_MS = 30000;
const STATUS_TOGGLE_CALLBACK_PREFIX = 'status_toggle';

let botRunning = false;
let botLaunchPromise = null;
let botLaunchRetryTimer = null;
let botStopRequested = false;
let botInitialized = false;

// ─── Rate-limit sleep helper ───
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function buildCollapsedStatusMessage() {
  return '📡 <b>Current update</b>:';
}

function buildStatusToggleMarkup(groupId, expanded) {
  const mode = expanded ? 'hide' : 'show';
  const label = expanded ? 'Hide details ▲' : 'Show details ▼';
  return Markup.inlineKeyboard([
    [Markup.button.callback(label, `${STATUS_TOGGLE_CALLBACK_PREFIX}:${mode}:${groupId}`)],
  ]);
}

async function buildExpandedStatusMessage(group) {
  try {
    const snapshot = await resolveDispatchEtaSnapshotForGroup({
      telegram: bot.telegram,
      group,
    });
    return buildEtaMessage({
      group,
      context: snapshot.context,
      location: snapshot.location,
      source: snapshot.source,
      eta: snapshot.eta,
    });
  } catch (err) {
    if (err?.code === 'LOAD_CONTEXT_NOT_FOUND') {
      return `${buildCollapsedStatusMessage()}\n${escapeHtml(NO_CURRENT_LOAD_INFO_MESSAGE)}`;
    }
    throw err;
  }
}

/** Pick localized message text; `forceLanguage` overrides per-group language when set. */
function pickBroadcastMessage(messages, messageText, group, forceLanguage) {
  const lang =
    forceLanguage && ['en', 'ru', 'uz'].includes(forceLanguage)
      ? forceLanguage
      : (group && group.language) || 'en';
  if (messages && typeof messages === 'object') {
    return messages[lang] || messages.en || messageText;
  }
  return messageText;
}

function effectiveLangForConfirmation(group, forceLanguage) {
  if (forceLanguage && ['en', 'ru', 'uz'].includes(forceLanguage)) return forceLanguage;
  return (group && group.language) || 'en';
}

async function resolveRenderedBroadcastText({
  group,
  messageText,
  messages,
  forceLanguage,
  enablePlaceholders = true,
}) {
  const rawText = pickBroadcastMessage(messages, messageText, group, forceLanguage);
  if (!enablePlaceholders) return rawText;

  const profile = await db.getDriverProfileByGroupId(group.id);
  const context = buildBroadcastTemplateContext({ profile, group });
  const rendered = renderBroadcastTemplateStrict(rawText, context);
  if (rendered.unknownTokens.length > 0) {
    const err = new Error(`Unknown placeholders: ${rendered.unknownTokens.map((t) => `{${t}}`).join(', ')}`);
    err.code = 'BROADCAST_UNKNOWN_PLACEHOLDER';
    err.unknownTokens = rendered.unknownTokens;
    throw err;
  }
  if (rendered.missingTokens.length > 0) {
    const err = new Error(`Missing placeholder values: ${rendered.missingTokens.map((t) => `{${t}}`).join(', ')}`);
    err.code = 'BROADCAST_PLACEHOLDER_MISSING';
    err.missingTokens = rendered.missingTokens;
    throw err;
  }

  return rendered.rendered;
}

// ─── Detect permanent Telegram send errors (stale/dead groups) ───
// Kept as a thin re-export so nothing else has to change; the real logic
// lives in services/telegramHtml.js so it can be shared with safeSend().
const isPermanentSendError = isPermanentSendErrorFromHtml;

// HTML escape helper to prevent injection in Telegram messages
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Helper: get translation for a language ───
function getTranslation(translations, lang, fallback = 'en') {
  if (!translations || !Array.isArray(translations)) return null;
  const found = translations.find((t) => t.language === lang);
  if (found) return found;
  return translations.find((t) => t.language === fallback) || translations[0];
}

function isPollingConflict(err) {
  const description = err?.response?.description || err?.message || '';
  return err?.response?.error_code === 409
    || description.includes('terminated by other getUpdates request');
}

function scheduleBotLaunchRetry(delayMs) {
  if (botStopRequested || botRunning || botLaunchRetryTimer) return;

  const retryInMs = Math.min(delayMs, BOT_LAUNCH_MAX_RETRY_MS);
  console.warn(
    `[BOT] Telegram reports this token is already in use (long-poll conflict). `
    + `Retrying in ${retryInMs / 1000}s… (If this never clears: stop any second server using BOT_TOKEN, `
    + `or run @BotFather /revoke and update Render; a webhook on this bot is cleared automatically on each attempt.)`,
  );

  botLaunchRetryTimer = setTimeout(() => {
    botLaunchRetryTimer = null;
    launchBotWithRetry(Math.min(retryInMs * 2, BOT_LAUNCH_MAX_RETRY_MS)).catch((err) => {
      console.error('[BOT] Fatal error starting bot:', err.message);
      process.exit(1);
    });
  }, retryInMs);
}

async function launchBotWithRetry(delayMs = BOT_LAUNCH_RETRY_MS) {
  if (botStopRequested || botRunning || botLaunchPromise) return;

  console.log('[BOT] Launching Telegram bot...');
  botRunning = true;

  async function startPollingAfterClearingWebhook() {
    // If this bot ever had a webhook URL set, Telegram will reject or fight long-polling
    // until the webhook is removed. Same symptom as "two getUpdates" for operators.
    if (process.env.TELEGRAM_SKIP_DELETE_WEBHOOK_BEFORE_POLL !== 'true') {
      try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: false });
      } catch (whErr) {
        console.warn('[BOT] deleteWebhook before polling (non-fatal):', whErr.message);
      }
      await sleep(400);
    }
    // #region agent log
    debugLog('bot/bot.js:launch', 'starting bot.launch polling', {
      botRunning,
      botStopRequested,
    }, 'A');
    // #endregion
    return bot.launch();
  }

  botLaunchPromise = startPollingAfterClearingWebhook()
    .then(() => {
      botRunning = false;
      botLaunchPromise = null;

      if (!botStopRequested) {
        console.warn('[BOT] Polling loop exited. Retrying launch...');
        scheduleBotLaunchRetry(delayMs);
      }
    })
    .catch((err) => {
      botRunning = false;
      botLaunchPromise = null;

      if (isPollingConflict(err)) {
        scheduleBotLaunchRetry(delayMs);
        return;
      }

      console.error('[BOT] Fatal error starting bot:', err.message);
      process.exit(1);
    });
}

function safeStop(signal) {
  botStopRequested = true;

  if (botLaunchRetryTimer) {
    clearTimeout(botLaunchRetryTimer);
    botLaunchRetryTimer = null;
  }

  if (!botRunning) {
    console.warn(`[BOT] stop(${signal}) skipped: bot is not running.`);
    return;
  }

  try {
    bot.stop(signal);
  } catch (stopErr) {
    if (stopErr.message && stopErr.message.includes('Bot is not running')) {
      console.warn(`[BOT] stop(${signal}) skipped: bot already stopped.`);
      return;
    }
    throw stopErr;
  } finally {
    botRunning = false;
  }
}

// ─── Bot Startup ───
async function startBot() {
  try {
    if (botInitialized) return;
    botInitialized = true;

    // NOTE: index.js is responsible for calling db.initializeDatabase()
    // BEFORE startBot() so the bot never handles a message against a
    // schema that hasn't been migrated yet. Keeping the init out of here
    // also avoids running the schema SQL twice on hot reloads.
    // #region agent log
    bot.use(async (ctx, next) => {
      try {
        const text = ctx.message?.text || ctx.message?.caption || '';
        const chatType = ctx.chat?.type;
        const isGroup = chatType === 'group' || chatType === 'supergroup';
        const looksLikeCommand = typeof text === 'string' && text.trim().startsWith('/');
        if (isGroup && looksLikeCommand) {
          const entities = ctx.message?.entities || ctx.message?.caption_entities || [];
          const cmdEntity = entities[0];
          let commandTarget = null;
          let commandName = null;
          if (cmdEntity?.type === 'bot_command' && typeof text === 'string') {
            const slice = text.slice(cmdEntity.offset, cmdEntity.offset + cmdEntity.length);
            const atIdx = slice.indexOf('@');
            commandName = atIdx >= 0 ? slice.slice(1, atIdx) : slice.slice(1);
            commandTarget = atIdx >= 0 ? slice.slice(atIdx + 1) : null;
          }
          const botUsername = ctx.botInfo?.username || ctx.me || null;
          debugLog('bot/bot.js:incoming-command', 'group slash message received', {
            chatId: ctx.chat?.id,
            chatTitle: ctx.chat?.title || '',
            text: text.trim().slice(0, 80),
            commandName,
            commandTarget,
            botUsername,
            entityOffset: cmdEntity?.offset ?? null,
            routedToThisBot: !commandTarget || !botUsername
              || String(commandTarget).toLowerCase() === String(botUsername).toLowerCase(),
            updateType: ctx.updateType,
            botRunning,
            botInitialized,
          }, commandTarget && botUsername
            && String(commandTarget).toLowerCase() !== String(botUsername).toLowerCase()
            ? 'F'
            : 'A');
        }
      } catch (_) { /* ignore */ }
      return next();
    });
    // #endregion

    // ── 1. Detect when bot is added/removed from a group ──
    bot.on('my_chat_member', async (ctx) => {
      try {
        const chat = ctx.myChatMember.chat;
        const newStatus = ctx.myChatMember.new_chat_member.status;

        if (
          (chat.type === 'group' || chat.type === 'supergroup') &&
          (newStatus === 'member' || newStatus === 'administrator')
        ) {
          // Bot added (or re-added) — provisional active until AI/manual classification
          await db.reactivateGroupOnBotJoin(chat.id, chat.title);
          console.log(`[BOT] Added to group: ${chat.title} (${chat.id})`);
          // Cache the bot's new role so the "Bot Group Access" view updates
          // immediately after a super admin grants admin via the deep link.
          try {
            const grp = await db.getGroupByTelegramId(chat.id);
            if (grp) await db.updateGroupBotAccess(grp.id, newStatus, new Date().toISOString());
          } catch (accessErr) {
            console.warn('[BOT] Could not cache bot role on join:', accessErr.message);
          }
        } else if (
          (chat.type === 'group' || chat.type === 'supergroup') &&
          (newStatus === 'left' || newStatus === 'kicked')
        ) {
          // Bot removed — deactivate so broadcasts skip this group
          await db.deactivateGroup(chat.id);
          console.log(`[BOT] Removed from group: ${chat.title} (${chat.id}) — deactivated`);
        }
      } catch (err) {
        console.error('[BOT] Error handling my_chat_member:', err.message);
      }
    });

    // ── 2. Register drivers AND groups on any interaction ──
    bot.use(async (ctx, next) => {
      try {
        // Auto-register the group if not already in DB
        if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
          await db.upsertGroup(ctx.chat.id, ctx.chat.title || 'Unknown');
        }
        // Register the driver
        if (ctx.from && ctx.from.id && !ctx.from.is_bot) {
          await db.upsertDriver(
            ctx.from.id,
            ctx.from.username || null,
            ctx.from.first_name || null,
            ctx.from.last_name || null
          );
        }
      } catch (err) {
        console.error('[BOT] Error registering driver/group:', err.message);
      }
      return next();
    });

    bot.on('message', async (ctx, next) => {
      try {
        // Catch Telegram group upgrades to Supergroups
        if (ctx.message && ctx.message.migrate_to_chat_id) {
          const oldId = ctx.chat.id;
          const newId = ctx.message.migrate_to_chat_id;
          try {
            await db.query(
              'UPDATE groups SET telegram_group_id = $1 WHERE telegram_group_id = $2', 
              [newId, oldId]
            );
            console.log(`[BOT] Migrated group ID from ${oldId} to ${newId}`);
          } catch (e) {
            console.error('[BOT] Failed to migrate group ID:', e.message);
          }
          return next();
        }
        const chat = ctx.chat;
        // Only log if it's a group
        if (chat && (chat.type === 'group' || chat.type === 'supergroup')) {
          const group = await db.getGroupByTelegramId(chat.id);
          if (group && ctx.message?.pinned_message?.message_id) {
            const sourceEventDate = Number.isFinite(ctx.message.date)
              ? new Date(ctx.message.date * 1000).toISOString()
              : null;
            await db.upsertGroupPinnedMessageSnapshot({
              groupId: group.id,
              telegramGroupId: chat.id,
              pinnedMessage: ctx.message.pinned_message,
              sourceEventMessageId: ctx.message.message_id || null,
              sourceEventAt: sourceEventDate,
            });
          }

          // General message logging is intentionally disabled: we no longer
          // persist every group message to chat_logs. Only load-relevant
          // messages are processed (below), which feeds /status and /load via
          // group_recent_loads. Pinned-message snapshots are still captured
          // above for the same reason.
          if (group && group.group_type === 'driver' && group.active && ctx.message) {
            scheduleLoadIngest(bot.telegram, group, ctx.message);
          }

          // Bot-visibility diagnostic + home-time tracker for driver groups.
          // Recording "we saw a message" proves the bot can read this group
          // (admin / privacy off), powering the "Bot Group Access" admin view.
          if (group && group.group_type === 'driver' && ctx.message) {
            const seenAtIso = Number.isFinite(ctx.message.date)
              ? new Date(ctx.message.date * 1000).toISOString()
              : new Date().toISOString();
            db.recordGroupMessageSeen(group.id, seenAtIso).catch(() => {});
            // Watch for "Status: Home / Ready / Rolling". Never throws.
            await handleDriverGroupStatus(bot.telegram, group, ctx.message);

            // Keep a short rolling buffer of this group's chat so the home-time
            // request feature has ~30 min of context for the AI.
            const msgText = ctx.message.text || ctx.message.caption || '';
            if (msgText && !ctx.from?.is_bot) {
              const senderName = ctx.from?.username
                ? `@${ctx.from.username}`
                : [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'Driver';
              recentMessageBuffer.recordMessage(group.telegram_group_id, {
                sender: senderName,
                text: msgText,
                at: Number.isFinite(ctx.message.date) ? ctx.message.date * 1000 : Date.now(),
              });
            }

            // A rep tagged an approver → maybe a home-time request. Runs detached
            // (it makes a slow AI call) and never throws; it posts its own card.
            if (messageMentionsApprovers(ctx.message)) {
              handleApproverMention(bot.telegram, group, ctx.message).catch((err) => {
                console.error('[BOT] handleApproverMention failed:', err.message);
              });
            } else {
              // Not an approver tag, but it may be the driver's reply to the bot's
              // "what dates?" question for a request that is awaiting dates. Cheap
              // no-op unless a request is actually waiting. Runs detached.
              handleHomeTimeDateReply(bot.telegram, group, ctx.message).catch((err) => {
                console.error('[BOT] handleHomeTimeDateReply failed:', err.message);
              });
            }
          }
        }
      } catch (err) {
        console.error('[BOT] Error processing group message:', err.message);
      }
      return next();
    });

    registerDatatruckPeerHandlers(bot);
    registerCreatorMessageManager(bot);

    // Summarize resolved load context (stored recent loads → pin → chat history). No GPS.
    bot.command('load', async (ctx) => {
      try {
        // #region agent log
        debugLog('bot/bot.js:load', '/load handler entered', {
          chatId: ctx.chat?.id,
          chatType: ctx.chat?.type,
        }, 'C');
        // #endregion
        const chatType = ctx.chat?.type;
        if (chatType !== 'group' && chatType !== 'supergroup') {
          await ctx.reply('Use /load inside a driver group chat.');
          return;
        }

        const group = await db.getGroupByTelegramId(ctx.chat.id);
        // #region agent log
        debugLog('bot/bot.js:load', '/load group lookup', {
          chatId: ctx.chat?.id,
          found: Boolean(group),
          groupType: group?.group_type || null,
          active: group?.active ?? null,
          groupId: group?.id ?? null,
        }, 'B');
        // #endregion
        if (!group || group.group_type !== 'driver' || !group.active) {
          await ctx.reply('This command works only in active driver groups.');
          return;
        }

        const context = await readLoadContextWithFallbacks({
          telegram: bot.telegram,
          chatId: ctx.chat.id,
          groupId: group.id,
        });

        const lines = [
          `Resolved from: ${context.source}`,
          `Pickup: ${context.pickupSummary || '—'}`,
          `Delivery: ${context.deliverySummary || '—'}`,
          `Destination (routing): ${context.destinationQuery || '—'}`,
        ];
        await ctx.reply(lines.join('\n'));
      } catch (err) {
        if (err?.code === 'LOAD_CONTEXT_NOT_FOUND') {
          await ctx.reply(NO_CURRENT_LOAD_INFO_MESSAGE);
          return;
        }
        console.error('[BOT] /load failed:', err.message);
        await ctx.reply('Could not resolve load context right now.');
      }
    });

    // Dispatcher helper: post live truck location for this group's unit number.
    bot.command('location', async (ctx) => {
      try {
        // #region agent log
        debugLog('bot/bot.js:location', '/location handler entered', {
          chatId: ctx.chat?.id,
          chatType: ctx.chat?.type,
          chatTitle: ctx.chat?.title || '',
        }, 'C');
        // #endregion
        const chatType = ctx.chat?.type;
        if (chatType !== 'group' && chatType !== 'supergroup') {
          await ctx.reply('Use /location inside a driver group chat.');
          return;
        }

        const groupTitle = ctx.chat?.title || '';
        let resolved = null;
        try {
          resolved = await resolveLiveLocationForGroupTitle(groupTitle);
        } catch (err) {
          if (err.code === 'UNIT_NOT_FOUND_IN_GROUP_TITLE') {
            await ctx.reply('Could not find a unit number in this group title.');
            return;
          }
          console.error('[BOT] /location provider chain failed:', err.message);
          await ctx.reply('Could not fetch live location from Samsara, EVO ELD, or TT ELD right now.');
          return;
        }
        const { location, source } = resolved;

        if (location.driverNameMismatch && isLocationDriverNameStrict()) {
          await ctx.reply(buildStrictMismatchBlockMessage(location));
          return;
        }

        await ctx.replyWithLocation(location.latitude, location.longitude);
        await ctx.reply(buildLocationSummaryLines({ location, source }).join('\n'));
        // #region agent log
        debugLog('bot/bot.js:location', '/location succeeded', {
          chatId: ctx.chat?.id,
          source,
          hasCoords: Boolean(location?.latitude && location?.longitude),
        }, 'D');
        // #endregion
      } catch (err) {
        // #region agent log
        debugLog('bot/bot.js:location', '/location failed', {
          chatId: ctx.chat?.id,
          error: err?.message || String(err),
          code: err?.code || null,
        }, 'D');
        // #endregion
        console.error('[BOT] /location failed:', err.message);
        await ctx.reply('Could not fetch live location right now. Please try again in a minute.');
      }
    });

    // Dispatcher ETA helper: manually trigger immediate ETA update if feature is enabled.
    bot.command('update', async (ctx) => {
      try {
        const chatType = ctx.chat?.type;
        if (chatType !== 'group' && chatType !== 'supergroup') {
          await ctx.reply('Use /update inside a driver group chat.');
          return;
        }

        const group = await db.getGroupByTelegramId(ctx.chat.id);
        if (!group || group.group_type !== 'driver' || !group.active) {
          await ctx.reply('This command works only in active driver groups.');
          return;
        }

        const setting = await db.getDispatchEtaSettingByGroupId(group.id);
        if (!setting || !setting.enabled) {
          await ctx.reply('ETA updates are currently turned off for this group.');
          return;
        }

        await ctx.reply('Running ETA update now...');
        const result = await triggerDispatchEtaNowByGroupId(group.id);
        if (result?.success) {
          await ctx.reply('ETA update sent.');
          return;
        }

        if (result?.triggered === false && result?.reason === 'not_enabled_or_already_processing') {
          await ctx.reply('ETA update is already running. Please wait a moment.');
          return;
        }

        const detail = result?.error || 'Unknown error';
        await ctx.reply(`ETA update failed: ${detail}`);
      } catch (err) {
        console.error('[BOT] /update failed:', err.message);
        await ctx.reply('Could not run ETA update right now. Please try again shortly.');
      }
    });

    bot.start(async (ctx) => {
      const chatType = ctx.chat?.type;
      if (chatType === 'group' || chatType === 'supergroup') {
        // Added to a group via the "Request admin" deep link → verify it landed
        // in the intended group and DM the super admin a confirmation.
        const payload = ctx.startPayload || '';
        if (payload.startsWith('htadmin_')) {
          await confirmAdminGrant(bot.telegram, {
            chatTelegramId: ctx.chat.id,
            chatTitle: ctx.chat.title || '',
            payload,
          });
          return;
        }
        await ctx.reply(
          'Wenze Feedback bot is active in this group for driver feedback, broadcasts, and ETA updates.',
        );
        return;
      }
      await ctx.reply(
        'Add me to your driver Telegram group to get started. '
        + 'For Facebook lead alerts, use the WenzeLeadBots bot in your leads group.',
      );
    });

    // Test hub: interactive driver lookup for /status (before driver-group /status).
    registerDispatchStatusLookupHandlers(bot);

    // Dispatcher status helper: always available, even if auto updates are disabled.
    bot.command('status', async (ctx) => {
      try {
        // #region agent log
        debugLog('bot/bot.js:status', '/status handler entered', {
          chatId: ctx.chat?.id,
          chatType: ctx.chat?.type,
        }, 'C');
        // #endregion
        const chatType = ctx.chat?.type;
        if (chatType !== 'group' && chatType !== 'supergroup') {
          await ctx.reply('Use /status inside a driver group chat.');
          return;
        }

        const testHub = await isDispatchEtaTestHub(ctx);
        // #region agent log
        debugLog('bot/bot.js:status', '/status test hub check', {
          chatId: ctx.chat?.id,
          testHub,
        }, 'E');
        // #endregion
        if (testHub) {
          await handleTestHubStatusCommand(ctx);
          return;
        }

        const group = await db.getGroupByTelegramId(ctx.chat.id);
        // #region agent log
        debugLog('bot/bot.js:status', '/status group lookup', {
          chatId: ctx.chat?.id,
          found: Boolean(group),
          groupType: group?.group_type || null,
          active: group?.active ?? null,
          groupId: group?.id ?? null,
        }, 'B');
        // #endregion
        if (!group || group.group_type !== 'driver' || !group.active) {
          await ctx.reply('This command works only in active driver groups.');
          return;
        }

        await ctx.reply('Building status update...');
        const telegram = ctx.telegram;
        const destinationChatId = ctx.chat.id;
        const driverGroup = group;

        runStatusSnapshotDetached({
          telegram,
          driverGroup,
          destinationChatId,
          targetMode: 'driver',
          interactive: true,
        }).catch(() => {});
        // #region agent log
        debugLog('bot/bot.js:status', '/status snapshot detached', {
          chatId: ctx.chat?.id,
          groupId: group.id,
        }, 'D');
        // #endregion
      } catch (err) {
        // #region agent log
        debugLog('bot/bot.js:status', '/status failed', {
          chatId: ctx.chat?.id,
          error: err?.message || String(err),
          code: err?.code || null,
        }, 'D');
        // #endregion
        console.error('[BOT] /status failed:', err.message);
        await ctx.reply('Could not build current status right now. Please try again shortly.');
      }
    });

    // Register employee voting handlers BEFORE generic callback_query handler
    // so bot.action(/vote_unit_/) fires first for voting callbacks
    const { registerVotingHandlers } = require('./employeeVoting');
    registerVotingHandlers(bot);

    // Mileage bonus Paid / Rejected buttons (accounting-only).
    registerMileageBonusHandlers(bot);

    // Home-time request Approve / Do Not Approve buttons (approvers-only).
    registerHomeTimeRequestHandlers(bot);

    // ── Handler: confirmation broadcast button clicks ──
    bot.action(/^bcast_(\d+)_(\d+)$/, async (ctx) => {
      try {
        const match = ctx.match;
        const broadcastId = parseInt(match[1], 10);
        const buttonIndex = parseInt(match[2], 10);
        const from = ctx.from;
        const chat = ctx.callbackQuery?.message?.chat;

        const result = await db.saveBroadcastButtonClick({
          broadcast_id: broadcastId,
          button_index: buttonIndex,
          button_label: null, // label not stored in callback data
          driver_telegram_id: from.id,
          driver_username: from.username || null,
          driver_first_name: from.first_name || null,
          driver_last_name: from.last_name || null,
          group_telegram_id: chat?.id || null,
          group_name: chat?.title || null,
        });

        if (!result) {
          await ctx.answerCbQuery('You have already responded.');
        } else {
          await ctx.answerCbQuery('✅ Response recorded!');
          console.log(`[BOT] Broadcast button click: broadcast=${broadcastId}, button=${buttonIndex}, driver=${from.id}`);
        }
      } catch (err) {
        console.error('[BOT] Error handling bcast callback:', err.message);
        try { await ctx.answerCbQuery('An error occurred.'); } catch (err) { console.warn('[BOT] Failed to answer callback query:', err.message); }
      }
    });

    // ── Handler: test broadcast button clicks (no tracking) ──
    bot.action(/^test_bcast_/, async (ctx) => {
      await ctx.answerCbQuery('This is a test preview. Responses are not recorded.');
    });

    // ── 3. Handle TEST callback queries (test preview buttons) ──
    bot.on('callback_query', async (ctx) => {
      try {
        const data = ctx.callbackQuery.data;

        // Handle test preview buttons
        if (data && data.startsWith('test_answer_')) {
          await ctx.answerCbQuery('This is a test preview. Responses are not recorded.');
          return;
        }

        if (!data || !data.startsWith('answer_')) {
          // Unknown callback data — acknowledge to clear Telegram UI spinner
          try { await ctx.answerCbQuery(); } catch (err) { console.warn('[BOT] Failed to answer callback query:', err.message); }
          return;
        }

        const parts = data.split('_');
        // format: answer_{questionId}_{optionId}
        if (parts.length !== 3) return;

        const questionId = parseInt(parts[1], 10);
        const optionId = parseInt(parts[2], 10);

        if (isNaN(questionId) || isNaN(optionId)) return;

        // Get or register driver
        const driver = await db.upsertDriver(
          ctx.from.id,
          ctx.from.username || null,
          ctx.from.first_name || null,
          ctx.from.last_name || null
        );

        // Get group
        const chatId = ctx.callbackQuery.message?.chat?.id;
        let group = null;
        if (chatId) {
          group = await db.getGroupByTelegramId(chatId);
          if (!group) {
            // Auto-register group if not exists
            const chatTitle = ctx.callbackQuery.message?.chat?.title || 'Unknown';
            group = await db.upsertGroup(chatId, chatTitle);
          }
        }

        if (!driver || !group) {
          await ctx.answerCbQuery('Error processing your response.');
          return;
        }

        // Save response (duplicate-safe)
        const response = await db.saveResponse(
          driver.id,
          group.id,
          questionId,
          optionId
        );

        if (!response) {
          await ctx.answerCbQuery('You have already answered this question.');
          return;
        }

        await ctx.answerCbQuery('Thank you for your feedback!');
        console.log(`[BOT] Answer received: driver=${driver.telegram_user_id}, question=${questionId}, option=${optionId}`);

        // ── 4. Report to management group ──
        await reportToManagement(driver, group, questionId, optionId);
      } catch (err) {
        console.error('[BOT] Error handling callback:', err.message);
        try {
          await ctx.answerCbQuery('An error occurred. Please try again.');
        } catch (err) { console.warn('[BOT] Failed to answer callback query:', err.message); }
      }
    });

    // Signal handling is centralized in index.js::shutdownAll, which calls
    // safeStop() explicitly. Registering process-level handlers here would
    // race with that coordinator (bot would stop before HTTP server drained).

    launchBotWithRetry();
  } catch (err) {
    console.error('[BOT] Fatal error starting bot:', err.message);
    process.exit(1);
  }
}

// ─── Report to management group ───
async function reportToManagement(driver, group, questionId, optionId) {
  try {
    const question = await db.getQuestionWithOptions(questionId);
    if (!question) return;

    const englishQ = getTranslation(question.translations, 'en');
    const questionText = englishQ ? englishQ.question_text : 'Unknown question';

    let optionText = 'Unknown answer';
    if (question.options) {
      for (const opt of question.options) {
        if (opt.id === optionId) {
          const englishO = getTranslation(opt.translations, 'en');
          optionText = englishO ? englishO.option_text : 'Unknown answer';
          break;
        }
      }
    }

    const driverHandle = driver.username
      ? `@${escapeHtml(driver.username)}`
      : escapeHtml(`${driver.first_name || ''} ${driver.last_name || ''}`.trim());

    const message = `📋 <b>Driver Feedback</b>\n\n` +
      `<b>Group:</b> ${escapeHtml(group.group_name)}\n` +
      `<b>Driver:</b> ${driverHandle}\n\n` +
      `<b>Question:</b>\n${escapeHtml(questionText)}\n\n` +
      `<b>Answer:</b>\n${escapeHtml(optionText)}`;

    await safeSend(
      () => bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, message, { parse_mode: 'HTML' }),
      { maxAttempts: 4, baseDelayMs: 750 }
    );

    console.log(`[BOT] Report sent to management for driver=${driverHandle}`);
  } catch (err) {
    // safeSend already retried with exponential backoff + 429 awareness,
    // so by the time we get here the failure is effectively permanent.
    console.error('[BOT] Error reporting to management (after retries):', err.message);
  }
}

/**
 * Send media to a chat.
 * - 1 item: sendPhoto/sendVideo (supports caption + inline keyboard buttons)
 * - 2-10 items: sendMediaGroup album (caption on first item only; no buttons on album)
 *
 * @param {string|number} chatId
 * @param {Array<{file_id, media_type}>} mediaItems
 * @param {string|null} caption
 * @param {string|null} parseMode  e.g. 'HTML'
 * @param {object|null} keyboard   Markup.inlineKeyboard(...) — only used for single-file
 */
async function sendMedia(chatId, mediaItems, caption, parseMode, keyboard) {
  const normalizedMediaItems = normalizeMediaItems(mediaItems);
  if (!normalizedMediaItems.length) return;

  // Telegram limits captions to 1024 chars. If longer, send media without caption, then send text.
  let safeCaption = caption;
  let textToFollowUp = null;
  if (caption && caption.length > 1000) {
    safeCaption = null;
    textToFollowUp = caption;
  }

  if (normalizedMediaItems.length === 1) {
    // Single file
    const { file_id, media_type } = normalizedMediaItems[0];
    const opts = { ...(keyboard || {}) };
    if (safeCaption) {
      opts.caption = safeCaption;
      if (parseMode) opts.parse_mode = parseMode;
    }
    if (media_type === 'video') {
      await bot.telegram.sendVideo(chatId, file_id, opts);
    } else {
      await bot.telegram.sendPhoto(chatId, file_id, opts);
    }
  } else {
    // Multiple files (Album)
    const group = normalizedMediaItems.map((m, i) => ({
      type: m.media_type === 'video' ? 'video' : 'photo',
      media: m.file_id,
      ...(i === 0 && safeCaption ? { caption: safeCaption, parse_mode: parseMode } : {}),
    }));
    await bot.telegram.sendMediaGroup(chatId, group);
  }

  // If the caption was too long, send it as a standalone text message immediately after
  if (textToFollowUp) {
    await bot.telegram.sendMessage(chatId, textToFollowUp, { 
      parse_mode: parseMode,
      ...(keyboard || {}) 
    });
  }
}

// ─── Send question to all groups ───
async function sendQuestionToGroups(questionId) {
  const question = await db.getQuestionWithOptions(questionId);
  if (!question) throw new Error(`Question not found: ${questionId}`);

  const groups = await db.getAllGroups();
  const results = { sent: 0, failed: 0, errors: [] };

  const mediaItems = normalizeMediaItems(question.media_items || []);
  const hasMedia = mediaItems.length > 0;
  const mediaPosition = question.media_position || 'above';
  const isAlbum = mediaItems.length > 1;

  for (const group of groups) {
    try {
      const lang = group.language || 'en';
      const qTranslation = getTranslation(question.translations, lang);
      const questionText = qTranslation ? qTranslation.question_text : 'Question';

      const buttons = [];
      if (question.options) {
        for (const opt of question.options) {
          const oTranslation = getTranslation(opt.translations, lang);
          const optionText = oTranslation ? oTranslation.option_text : `Option ${opt.option_order}`;
          buttons.push([Markup.button.callback(optionText, `answer_${questionId}_${opt.id}`)]);
        }
      }

      const messageText = `📋 ${questionText}`;
      const keyboard = Markup.inlineKeyboard(buttons);

      if (!hasMedia) {
        // ── No media ──
        await bot.telegram.sendMessage(group.telegram_group_id, messageText, keyboard);
      } else if (mediaPosition === 'above') {
        if (isAlbum) {
          // ── Album above: send album (caption on first), then text + buttons ──
          await sendMedia(group.telegram_group_id, mediaItems, messageText, 'HTML', null);
          await bot.telegram.sendMessage(group.telegram_group_id, messageText, keyboard);
        } else {
          // ── Single media above: send with caption + buttons ──
          await sendMedia(group.telegram_group_id, mediaItems, messageText, 'HTML', keyboard);
        }
      } else {
        // ── Media below: text + buttons first, then media ──
        await bot.telegram.sendMessage(group.telegram_group_id, messageText, keyboard);
        await sendMedia(group.telegram_group_id, mediaItems, null, null, null);
      }

      results.sent++;
      console.log(`[BOT] Question sent to group: ${group.group_name} (${group.telegram_group_id}) in ${lang}`);
    } catch (err) {
      // Retry once on rate-limit (429)
      if (err.response && err.response.error_code === 429) {
        const retryAfter = (err.response.parameters && err.response.parameters.retry_after) || 5;
        console.warn(`[BOT] Rate limited on ${group.group_name}, retrying after ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        try {
          const lang = group.language || 'en';
          const qTranslation = getTranslation(question.translations, lang);
          const questionText = qTranslation ? qTranslation.question_text : 'Question';
          const btns = [];
          if (question.options) {
            for (const opt of question.options) {
              const oTranslation = getTranslation(opt.translations, lang);
              const optionText = oTranslation ? oTranslation.option_text : `Option ${opt.option_order}`;
              btns.push([Markup.button.callback(optionText, `answer_${questionId}_${opt.id}`)]);
            }
          }
          const messageText = `📋 ${questionText}`;
          const keyboard = Markup.inlineKeyboard(btns);
          if (!hasMedia) {
            await bot.telegram.sendMessage(group.telegram_group_id, messageText, keyboard);
          } else if (mediaPosition === 'above') {
            if (isAlbum) {
              await sendMedia(group.telegram_group_id, mediaItems, messageText, 'HTML', null);
              await bot.telegram.sendMessage(group.telegram_group_id, messageText, keyboard);
            } else {
              await sendMedia(group.telegram_group_id, mediaItems, messageText, 'HTML', keyboard);
            }
          } else {
            await bot.telegram.sendMessage(group.telegram_group_id, messageText, keyboard);
            await sendMedia(group.telegram_group_id, mediaItems, null, null, null);
          }
          results.sent++;
          console.log(`[BOT] Question sent (retry) to group: ${group.group_name}`);
        } catch (retryErr) {
          results.failed++;
          results.errors.push({ group: group.group_name, error: retryErr.message });
          console.error(`[BOT] Retry failed for ${group.group_name}:`, retryErr.message);
        }
      } else {
        results.failed++;
        results.errors.push({ group: group.group_name, error: err.message });
        console.error(`[BOT] Failed to send to group ${group.group_name}:`, err.message);
        // Auto-deactivate groups where the bot was kicked/group deleted
        if (isPermanentSendError(err)) {
          try { await db.deactivateGroup(group.telegram_group_id); } catch (_) {}
          console.warn(`[BOT] Auto-deactivated stale group: ${group.group_name} (${group.telegram_group_id})`);
        }
      }
    }
    await sleep(50);
  }

  return results;
}

// ─── Send test question to management group ───
async function sendTestQuestion(questionEn, optionsEn, mediaItems, mediaPosition) {
  const buttons = optionsEn.map((text, i) => [
    Markup.button.callback(text, `test_answer_${i + 1}`),
  ]);

  const message = `🧪 <b>TEST QUESTION PREVIEW</b>\n\n${escapeHtml(questionEn)}\n\n<i>Choose an option:</i>`;
  const keyboard = Markup.inlineKeyboard(buttons);
  const normalizedMediaItems = normalizeMediaItems(mediaItems);
  const hasMedia = normalizedMediaItems.length > 0;
  const isAlbum = normalizedMediaItems.length > 1;
  const position = mediaPosition || 'above';

  if (!hasMedia) {
    await bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, message, { parse_mode: 'HTML', ...keyboard });
  } else if (position === 'above') {
    if (isAlbum) {
      await sendMedia(MANAGEMENT_GROUP_ID, normalizedMediaItems, message, 'HTML', null);
      await bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, message, { parse_mode: 'HTML', ...keyboard });
    } else {
      await sendMedia(MANAGEMENT_GROUP_ID, normalizedMediaItems, message, 'HTML', keyboard);
    }
  } else {
    await bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, message, { parse_mode: 'HTML', ...keyboard });
    await sendMedia(MANAGEMENT_GROUP_ID, normalizedMediaItems, null, null, null);
  }

  console.log('[BOT] Test question sent to management group.');
}

// ─── Send broadcast message to all driver groups (legacy helper) ───
async function sendBroadcast(messageText, parseMode, messages, mediaItems, mediaPosition, broadcastId, forceLanguage) {
  const groups = await db.getAllDriverGroups();
  return sendBroadcastToGroups(
    groups,
    messageText,
    parseMode,
    messages,
    mediaItems,
    mediaPosition,
    broadcastId,
    forceLanguage
  );
}

// ─── Send broadcast test to management group ───
async function sendBroadcastTest(messageText, parseMode, messages, mediaItems, mediaPosition, forceLanguage) {
  const fakeGroup = { language: 'en' };
  const text = pickBroadcastMessage(messages, messageText, fakeGroup, forceLanguage);
  const normalizedMediaItems = normalizeMediaItems(mediaItems);
  const hasMedia = normalizedMediaItems.length > 0;
  const position = mediaPosition || 'above';

  if (!hasMedia) {
    await bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, text, { parse_mode: parseMode });
  } else if (position === 'above') {
    await sendMedia(MANAGEMENT_GROUP_ID, normalizedMediaItems, text, parseMode, null);
  } else {
    await bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, text, { parse_mode: parseMode });
    await sendMedia(MANAGEMENT_GROUP_ID, normalizedMediaItems, null, null, null);
  }
  console.log('[BOT] Broadcast test sent to management group.');
}

// ─── Send broadcast to specific groups (used by scheduler + API) ───
async function sendBroadcastToGroups(
  groups,
  messageText,
  parseMode,
  messages,
  mediaItems,
  mediaPosition,
  broadcastId,
  forceLanguage,
  options = {}
) {
  const results = { sent: 0, failed: 0, errors: [] };
  if (!groups || !Array.isArray(groups) || groups.length === 0) {
    console.warn('[BOT] sendBroadcastToGroups: no groups to send to');
    return results;
  }

  const normalizedMediaItems = normalizeMediaItems(mediaItems);
  const hasMedia = normalizedMediaItems.length > 0;
  const position = mediaPosition || 'above';
  const enablePlaceholders = options.enablePlaceholders !== false;

  for (const group of groups) {
    let success = false;
    let errorMsg = null;
    try {
      const text = await resolveRenderedBroadcastText({
        group,
        messageText,
        messages,
        forceLanguage,
        enablePlaceholders,
      });

      if (!hasMedia) {
        await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode });
      } else if (position === 'above') {
        await sendMedia(group.telegram_group_id, normalizedMediaItems, text, parseMode, null);
      } else {
        await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode });
        await sendMedia(group.telegram_group_id, normalizedMediaItems, null, null, null);
      }

      results.sent++;
      success = true;
      console.log(`[BOT] Broadcast sent to: ${group.group_name} (${group.telegram_group_id})`);
    } catch (err) {
      // Retry once on rate-limit (429)
      if (err.response && err.response.error_code === 429) {
        const retryAfter = (err.response.parameters && err.response.parameters.retry_after) || 5;
        console.warn(`[BOT] Rate limited on ${group.group_name}, retrying after ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        try {
          const text = await resolveRenderedBroadcastText({
            group,
            messageText,
            messages,
            forceLanguage,
            enablePlaceholders,
          });
          if (!hasMedia) {
            await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode });
          } else if (position === 'above') {
            await sendMedia(group.telegram_group_id, normalizedMediaItems, text, parseMode, null);
          } else {
            await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode });
            await sendMedia(group.telegram_group_id, normalizedMediaItems, null, null, null);
          }
          results.sent++;
          success = true;
          console.log(`[BOT] Broadcast sent (retry) to: ${group.group_name}`);
        } catch (retryErr) {
          results.failed++;
          errorMsg = retryErr.message;
          results.errors.push({
            group: group.group_name,
            error: retryErr.message,
            ...(retryErr.missingTokens ? { missing_tokens: retryErr.missingTokens } : {}),
            ...(retryErr.unknownTokens ? { unknown_tokens: retryErr.unknownTokens } : {}),
          });
          console.error(`[BOT] Broadcast retry failed for ${group.group_name}:`, retryErr.message);
        }
      } else {
        results.failed++;
        errorMsg = err.message;
        results.errors.push({
          group: group.group_name,
          error: err.message,
          ...(err.missingTokens ? { missing_tokens: err.missingTokens } : {}),
          ...(err.unknownTokens ? { unknown_tokens: err.unknownTokens } : {}),
        });
        console.error(`[BOT] Broadcast failed for ${group.group_name}:`, err.message);
        if (isPermanentSendError(err)) {
          try { await db.deactivateGroup(group.telegram_group_id); } catch (_) {}
          console.warn(`[BOT] Auto-deactivated stale group: ${group.group_name} (${group.telegram_group_id})`);
        }
      }
    }

    // Record delivery if broadcastId provided
    if (broadcastId) {
      try {
        await db.createBroadcastDelivery({
          broadcast_id: broadcastId,
          group_id: group.id,
          telegram_group_id: group.telegram_group_id,
          group_name: group.group_name,
          status: success ? 'sent' : 'failed',
          error_message: errorMsg,
        });
      } catch (dbErr) {
        console.error('[BOT] Failed to record delivery:', dbErr.message);
      }
    }

    await sleep(50);
  }

  console.log(`[BOT] Targeted broadcast complete: ${results.sent} sent, ${results.failed} failed`);
  return results;
}

// ─── Send confirmation broadcast with inline buttons ───
async function sendConfirmationBroadcast(
  messageText,
  parseMode,
  messages,
  mediaItems,
  mediaPosition,
  buttons,
  broadcastId,
  targetGroups,
  forceLanguage,
  options = {}
) {
  let groups;
  if (Array.isArray(targetGroups) && targetGroups.length > 0) {
    groups = targetGroups;
  } else {
    groups = await db.getAllDriverGroups();
  }

  const results = { sent: 0, failed: 0, errors: [] };
  if (!groups || groups.length === 0) {
    console.warn('[BOT] sendConfirmationBroadcast: no groups to send to');
    return results;
  }

  const normalizedMediaItems = normalizeMediaItems(mediaItems);
  const hasMedia = normalizedMediaItems.length > 0;
  const position = mediaPosition || 'above';
  const btnList = Array.isArray(buttons) ? buttons : [];
  const enablePlaceholders = options.enablePlaceholders !== false;

  for (const group of groups) {
    let success = false;
    let errorMsg = null;
    try {
      const text = await resolveRenderedBroadcastText({
        group,
        messageText,
        messages,
        forceLanguage,
        enablePlaceholders,
      });
      const lang = effectiveLangForConfirmation(group, forceLanguage);

      const keyboardRows = btnList.map((btn, i) => {
        const label = btn[`label_${lang}`] || btn.label_en || btn.label_ru || btn.label_uz || `Button ${i + 1}`;
        return [Markup.button.callback(label, `bcast_${broadcastId}_${i}`)];
      });
      const keyboard = Markup.inlineKeyboard(keyboardRows);

      if (!hasMedia) {
        await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode, ...keyboard });
      } else if (position === 'above') {
        if (normalizedMediaItems.length === 1) {
          await sendMedia(group.telegram_group_id, normalizedMediaItems, text, parseMode, keyboard);
        } else {
          await sendMedia(group.telegram_group_id, normalizedMediaItems, text, parseMode, null);
          await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode, ...keyboard });
        }
      } else {
        await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode, ...keyboard });
        await sendMedia(group.telegram_group_id, normalizedMediaItems, null, null, null);
      }

      results.sent++;
      success = true;
      console.log(`[BOT] Confirmation broadcast sent to: ${group.group_name} (${group.telegram_group_id})`);
    } catch (err) {
      if (err.response && err.response.error_code === 429) {
        const retryAfter = (err.response.parameters && err.response.parameters.retry_after) || 5;
        console.warn(`[BOT] Rate limited on ${group.group_name}, retrying after ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        try {
          const text = await resolveRenderedBroadcastText({
            group,
            messageText,
            messages,
            forceLanguage,
            enablePlaceholders,
          });
          const lang = effectiveLangForConfirmation(group, forceLanguage);
          const keyboardRows = btnList.map((btn, i) => {
            const label = btn[`label_${lang}`] || btn.label_en || btn.label_ru || btn.label_uz || `Button ${i + 1}`;
            return [Markup.button.callback(label, `bcast_${broadcastId}_${i}`)];
          });
          const keyboard = Markup.inlineKeyboard(keyboardRows);
          if (!hasMedia) {
            await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode, ...keyboard });
          } else if (position === 'above') {
            if (normalizedMediaItems.length === 1) {
              await sendMedia(group.telegram_group_id, normalizedMediaItems, text, parseMode, keyboard);
            } else {
              await sendMedia(group.telegram_group_id, normalizedMediaItems, text, parseMode, null);
              await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode, ...keyboard });
            }
          } else {
            await bot.telegram.sendMessage(group.telegram_group_id, text, { parse_mode: parseMode, ...keyboard });
            await sendMedia(group.telegram_group_id, normalizedMediaItems, null, null, null);
          }
          results.sent++;
          success = true;
          console.log(`[BOT] Confirmation broadcast sent (retry) to: ${group.group_name}`);
        } catch (retryErr) {
          results.failed++;
          errorMsg = retryErr.message;
          results.errors.push({
            group: group.group_name,
            error: retryErr.message,
            ...(retryErr.missingTokens ? { missing_tokens: retryErr.missingTokens } : {}),
            ...(retryErr.unknownTokens ? { unknown_tokens: retryErr.unknownTokens } : {}),
          });
          console.error(`[BOT] Confirmation broadcast retry failed for ${group.group_name}:`, retryErr.message);
        }
      } else {
        results.failed++;
        errorMsg = err.message;
        results.errors.push({
          group: group.group_name,
          error: err.message,
          ...(err.missingTokens ? { missing_tokens: err.missingTokens } : {}),
          ...(err.unknownTokens ? { unknown_tokens: err.unknownTokens } : {}),
        });
        console.error(`[BOT] Confirmation broadcast failed for ${group.group_name}:`, err.message);
        if (isPermanentSendError(err)) {
          try { await db.deactivateGroup(group.telegram_group_id); } catch (_) {}
          console.warn(`[BOT] Auto-deactivated stale group: ${group.group_name} (${group.telegram_group_id})`);
        }
      }
    }

    if (broadcastId) {
      try {
        await db.createBroadcastDelivery({
          broadcast_id: broadcastId,
          group_id: group.id,
          telegram_group_id: group.telegram_group_id,
          group_name: group.group_name,
          status: success ? 'sent' : 'failed',
          error_message: errorMsg,
        });
      } catch (dbErr) {
        console.error('[BOT] Failed to record delivery:', dbErr.message);
      }
    }

    await sleep(50);
  }

  console.log(`[BOT] Confirmation broadcast complete: ${results.sent} sent, ${results.failed} failed`);
  return results;
}

// ─── Send confirmation broadcast test to management group ───
async function sendConfirmationBroadcastTest(
  messageText,
  parseMode,
  messages,
  mediaItems,
  mediaPosition,
  buttons,
  forceLanguage
) {
  const fakeGroup = { language: 'en' };
  const text = pickBroadcastMessage(messages, messageText, fakeGroup, forceLanguage);
  const lang = effectiveLangForConfirmation(fakeGroup, forceLanguage);
  const btnList = Array.isArray(buttons) ? buttons : [];

  const normalizedMediaItems = normalizeMediaItems(mediaItems);
  const hasMedia = normalizedMediaItems.length > 0;
  const position = mediaPosition || 'above';

  const keyboardRows = btnList.map((btn, i) => {
    const label = btn[`label_${lang}`] || btn.label_en || `Button ${i + 1}`;
    return [Markup.button.callback(label, `test_bcast_${i}`)];
  });
  const keyboard = Markup.inlineKeyboard(keyboardRows);

  if (!hasMedia) {
    await bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, text, { parse_mode: parseMode, ...keyboard });
  } else if (position === 'above') {
    if (normalizedMediaItems.length === 1) {
      await sendMedia(MANAGEMENT_GROUP_ID, normalizedMediaItems, text, parseMode, keyboard);
    } else {
      await sendMedia(MANAGEMENT_GROUP_ID, normalizedMediaItems, text, parseMode, null);
      await bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, text, { parse_mode: parseMode, ...keyboard });
    }
  } else {
    await bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, text, { parse_mode: parseMode, ...keyboard });
    await sendMedia(MANAGEMENT_GROUP_ID, normalizedMediaItems, null, null, null);
  }
  console.log('[BOT] Confirmation broadcast test sent to management group.');
}

// Exposed so the central shutdown coordinator (index.js) can stop the
// Telegraf polling loop during graceful shutdown.
function stopBot(signal = 'SHUTDOWN') {
  safeStop(signal);
}

module.exports = { bot, startBot, stopBot, sendQuestionToGroups, sendTestQuestion, sendBroadcast, sendBroadcastTest, sendBroadcastToGroups, sendConfirmationBroadcast, sendConfirmationBroadcastTest };
