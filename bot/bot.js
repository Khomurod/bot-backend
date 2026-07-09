/**
 * Telegram bot assembly.
 *
 * This file owns the Telegraf instance, the launch/retry/stop machinery, and
 * the ORDER in which handler modules register — middleware and catch-all
 * ordering is behavior, so every registration happens here, in one place.
 * The handlers themselves live under bot/handlers/, and the outbound send
 * family (questions/broadcasts) in bot/senders.js.
 */
const { Telegraf } = require('telegraf');
const config = require('../config/config');
const { telegramClientOptions } = require('../services/telegramAgent');
const db = require('../database/db');
const { registerHomeTimeRequestHandlers } = require('./homeTimeRequestHandlers');
const { registerDatatruckPeerHandlers } = require('./datatruckPeerHandlers');
const { registerRouteControlHandlers } = require('./routeControlHandlers');
const { registerMileageBonusHandlers } = require('./mileageBonusHandlers');
const { registerDocumentIntakeHandlers } = require('./documentIntakeHandlers');
const { registerLocationCheckinHandlers } = require('./locationCheckinHandlers');
const { registerCreatorMessageManager } = require('./creatorMessageManager');
const { registerCreatorControlPanel } = require('./creatorBroadcastHandlers');
const { registerAnonymousFeedbackHandlers } = require('./anonymousFeedbackHandlers');
const { registerDispatchStatusLookupHandlers } = require('./dispatchStatusLookupHandlers');
const { registerGroupCaptureHandlers } = require('./handlers/groupCaptureHandlers');
const {
  registerDispatchCommands,
  registerStatusCommand,
} = require('./handlers/dispatchCommandHandlers');
const { registerStartHandler } = require('./handlers/startHandlers');
const { registerSurveyCallbackHandlers } = require('./handlers/surveyCallbackHandlers');
const { createBotSenders } = require('./senders');
const { installBotSentMessageTracking } = require('../services/botSentMessageRegistry');
// config.js already validates DATABASE_URL, MANAGEMENT_GROUP_ID (BOT_TOKEN has a code default)
// and exits on missing values — no need to re-check here.

const bot = new Telegraf(config.botToken, { telegram: telegramClientOptions });
installBotSentMessageTracking(bot.telegram, db);
// Disabled leftover debug instrumentation. This previously POSTed to a
// hardcoded localhost agent-ingest endpoint on every command, which is a dead
// port in production. Kept as a no-op so existing call sites stay valid.
function debugLog() {}

// Outbound send family (questions/broadcasts). Created here so the senders
// close over THIS bot instance and the live db/config module objects.
const {
  sendQuestionToGroups,
  sendTestQuestion,
  sendBroadcast,
  sendBroadcastTest,
  sendBroadcastToGroups,
  sendConfirmationBroadcast,
  sendConfirmationBroadcastTest,
} = createBotSenders({ bot, db, config });

const BOT_LAUNCH_RETRY_MS = 5000;
const BOT_LAUNCH_MAX_RETRY_MS = 30000;

let botRunning = false;
let botLaunchPromise = null;
let botLaunchRetryTimer = null;
let botStopRequested = false;
let botInitialized = false;

// ─── Rate-limit sleep helper ───
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// NOTE: the old status-toggle helpers (buildCollapsedStatusMessage,
// buildStatusToggleMarkup, buildExpandedStatusMessage) were removed here.
// They were unreachable: never called, never exported, no `status_toggle:`
// callback handler exists anywhere, and buildExpandedStatusMessage referenced
// dispatchEtaUpdateService functions that were never imported, so calling it
// would have thrown a ReferenceError.

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

    // Group join/leave + user/group capture middleware + group message
    // pipeline (migration, pinned snapshots, home-time, fuel, chat buffer).
    registerGroupCaptureHandlers(bot);

    registerDatatruckPeerHandlers(bot);
    // Detect Google Maps route links from authorized dispatchers in driver
    // groups → create/update the Route Control assignment. Registered before the
    // callback_query catch-all so its Replace/Ignore buttons are handled.
    registerRouteControlHandlers(bot);
    registerCreatorMessageManager(bot);
    // Creator-only (user id 2117922421) messaging panel, restricted to the
    // bot's private chat: "Send Broadcast Message" (pick an audience) and
    // "Send Single Message" (pick one group). Delivers any content verbatim
    // via copyMessage. Reuses the shared broadcast targeting service.
    registerCreatorControlPanel(bot);

    // Dispatcher group commands: /load, /location, /update.
    registerDispatchCommands(bot);

    // /start: group welcome + admin-grant deep link, private anonymous feedback.
    registerStartHandler(bot);

    // Anonymous feedback flow (private chat only). Registered before the test-hub
    // /status lookup so its private-chat /cancel and text handling take priority;
    // it falls through (next) for group chats so group behavior is unchanged.
    registerAnonymousFeedbackHandlers(bot);

    // Test hub: interactive driver lookup for /status (before driver-group /status).
    registerDispatchStatusLookupHandlers(bot);

    // Dispatcher status helper: always available, even if auto updates are disabled.
    registerStatusCommand(bot);

    // Mileage bonus Paid / Rejected buttons (accounting-only).
    registerMileageBonusHandlers(bot);

    // Home-time request Approve / Do Not Approve buttons (approvers-only).
    registerHomeTimeRequestHandlers(bot);

    // Driver location check-in Yes / No buttons (driver answers).
    registerLocationCheckinHandlers(bot);

    // Smart BOL/POD intake: detect driver-sent documents, classify, and
    // confirm upload to Datatruck via Yes/No/Disregard buttons. Registered
    // before the callback_query catch-all so its dtdoc: actions are handled.
    registerDocumentIntakeHandlers(bot);

    // Broadcast buttons + the survey-answer callback_query catch-all. MUST be
    // last so it never swallows the feature-specific callbacks above.
    registerSurveyCallbackHandlers(bot);

    // Signal handling is centralized in index.js::shutdownAll, which calls
    // safeStop() explicitly. Registering process-level handlers here would
    // race with that coordinator (bot would stop before HTTP server drained).

    launchBotWithRetry();
  } catch (err) {
    console.error('[BOT] Fatal error starting bot:', err.message);
    process.exit(1);
  }
}

// Exposed so the central shutdown coordinator (index.js) can stop the
// Telegraf polling loop during graceful shutdown.
function stopBot(signal = 'SHUTDOWN') {
  safeStop(signal);
}

module.exports = { bot, startBot, stopBot, sendQuestionToGroups, sendTestQuestion, sendBroadcast, sendBroadcastTest, sendBroadcastToGroups, sendConfirmationBroadcast, sendConfirmationBroadcastTest };
