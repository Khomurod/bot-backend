const { Telegraf, Markup } = require('telegraf');
const config = require('../config/config');
const db = require('../database/db');
const { safeSend, isPermanentSendError: isPermanentSendErrorFromHtml } = require('../services/telegramHtml');
const { normalizeMediaItems } = require('../services/scheduledMessageUtils');
const { getLiveLocationForGroupTitle } = require('../services/samsaraLocationService');
const { getLiveLocationForGroupTitleFromEvo } = require('../services/evoEldService');
const { getLiveLocationForGroupTitleFromTt } = require('../services/ttEldService');

// config.js already validates BOT_TOKEN, DATABASE_URL, MANAGEMENT_GROUP_ID
// and exits on missing values — no need to re-check here.

const bot = new Telegraf(config.botToken);
const MANAGEMENT_GROUP_ID = config.managementGroupId;
const BOT_LAUNCH_RETRY_MS = 5000;
const BOT_LAUNCH_MAX_RETRY_MS = 30000;

let botRunning = false;
let botLaunchPromise = null;
let botLaunchRetryTimer = null;
let botStopRequested = false;
let botInitialized = false;

// ─── Rate-limit sleep helper ───
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
  console.warn(`[BOT] Another instance is still polling this token. Retrying launch in ${retryInMs / 1000}s...`);

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
  botLaunchPromise = bot.launch()
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

    // ── 1. Detect when bot is added/removed from a group ──
    bot.on('my_chat_member', async (ctx) => {
      try {
        const chat = ctx.myChatMember.chat;
        const newStatus = ctx.myChatMember.new_chat_member.status;

        if (
          (chat.type === 'group' || chat.type === 'supergroup') &&
          (newStatus === 'member' || newStatus === 'administrator')
        ) {
          // Bot added (or re-added) — upsert also reactivates if previously deactivated
          await db.upsertGroup(chat.id, chat.title);
          console.log(`[BOT] Added to group: ${chat.title} (${chat.id})`);
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
          const text = ctx.message.text || ctx.message.caption;
          if (text) {
            const group = await db.getGroupByTelegramId(chat.id);
            if (group) {
              const senderName = ctx.from.first_name || ctx.from.username || 'Unknown';
              const telegramMessageId = ctx.message.message_id || null;
              await db.logChatMessage(group.id, ctx.from.id, senderName, text, telegramMessageId);
            }
          }
        }
      } catch (err) {
        console.error('[BOT] Error logging chat message:', err.message);
      }
      return next();
    });

    // Dispatcher helper: post live truck location for this group's unit number.
    bot.command('location', async (ctx) => {
      try {
        const chatType = ctx.chat?.type;
        if (chatType !== 'group' && chatType !== 'supergroup') {
          await ctx.reply('Use /location inside a driver group chat.');
          return;
        }

        const groupTitle = ctx.chat?.title || '';
        let location = null;
        let source = 'Samsara';
        let samsaraError = null;
        let evoError = null;

        try {
          location = await getLiveLocationForGroupTitle({
            groupTitle,
            apiKey: config.samsaraApiKey,
            apiBase: config.samsaraApiBase,
          });
        } catch (err) {
          samsaraError = err;
          if (err.code === 'UNIT_NOT_FOUND_IN_GROUP_TITLE') {
            await ctx.reply('Could not find a unit number in this group title.');
            return;
          }
        }

        if (!location) {
          try {
            location = await getLiveLocationForGroupTitleFromEvo({
              groupTitle,
              usdotNumber: config.evoEldUsdotNumber,
              apiKey: config.evoEldApiKey,
              providerToken: config.evoEldProviderToken,
              apiBase: config.evoEldApiBase,
            });
            source = 'EVO ELD (fallback)';
          } catch (evoErr) {
            evoError = evoErr;
            console.error('[BOT] /location EVO fallback failed:', evoErr.message);
          }
        }

        if (!location) {
          const ttApiKeys = Array.from(
            new Set([config.ttEldApiKey, config.evoEldApiKey].filter(Boolean))
          );
          let ttError = null;

          for (const ttApiKey of ttApiKeys) {
            try {
              location = await getLiveLocationForGroupTitleFromTt({
                groupTitle,
                usdotNumber: config.ttEldUsdotNumber,
                apiKey: ttApiKey,
                providerToken: config.ttEldProviderToken,
                apiBase: config.ttEldApiBase,
              });
              source = 'TT ELD (fallback)';
              break;
            } catch (err) {
              ttError = err;
              console.error('[BOT] /location TT fallback attempt failed:', err.message);
            }
          }

          if (!location) {
            if (samsaraError) {
              console.error('[BOT] /location Samsara error before fallback:', samsaraError.message);
            }
            if (evoError) {
              console.error('[BOT] /location EVO error before TT fallback:', evoError.message);
            }
            if (ttError) {
              console.error('[BOT] /location TT error after all key attempts:', ttError.message);
            }
            await ctx.reply('Could not fetch live location from Samsara, EVO ELD, or TT ELD right now.');
            return;
          }
        }

        await ctx.replyWithLocation(location.latitude, location.longitude);

        const pingAgeText = location.pingAgeMinutes == null
          ? 'unknown'
          : `${location.pingAgeMinutes} min ago`;
        const speedText = location.speedMilesPerHour == null
          ? 'unknown'
          : `${location.speedMilesPerHour.toFixed(1)} mph`;

        const summary = [
          `Source: ${source}`,
          `Unit: ${location.unitNumber}`,
          `Vehicle: ${location.vehicleName}`,
          location.address ? `Address: ${location.address}` : null,
          `Last ping: ${pingAgeText}${location.pingTimeIso ? ` (${location.pingTimeIso})` : ''}`,
          `Speed: ${speedText}`,
        ].filter(Boolean).join('\n');

        await ctx.reply(summary);
      } catch (err) {
        console.error('[BOT] /location failed:', err.message);
        await ctx.reply('Could not fetch live location right now. Please try again in a minute.');
      }
    });

    // Register employee voting handlers BEFORE generic callback_query handler
    // so bot.action(/vote_unit_/) fires first for voting callbacks
    const { registerVotingHandlers } = require('./employeeVoting');
    registerVotingHandlers(bot);

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
  forceLanguage
) {
  const results = { sent: 0, failed: 0, errors: [] };
  if (!groups || !Array.isArray(groups) || groups.length === 0) {
    console.warn('[BOT] sendBroadcastToGroups: no groups to send to');
    return results;
  }

  const normalizedMediaItems = normalizeMediaItems(mediaItems);
  const hasMedia = normalizedMediaItems.length > 0;
  const position = mediaPosition || 'above';

  for (const group of groups) {
    let success = false;
    let errorMsg = null;
    try {
      const text = pickBroadcastMessage(messages, messageText, group, forceLanguage);

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
          const text = pickBroadcastMessage(messages, messageText, group, forceLanguage);
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
          results.errors.push({ group: group.group_name, error: retryErr.message });
          console.error(`[BOT] Broadcast retry failed for ${group.group_name}:`, retryErr.message);
        }
      } else {
        results.failed++;
        errorMsg = err.message;
        results.errors.push({ group: group.group_name, error: err.message });
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
  forceLanguage
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

  for (const group of groups) {
    let success = false;
    let errorMsg = null;
    try {
      const text = pickBroadcastMessage(messages, messageText, group, forceLanguage);
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
          const text = pickBroadcastMessage(messages, messageText, group, forceLanguage);
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
          results.errors.push({ group: group.group_name, error: retryErr.message });
          console.error(`[BOT] Confirmation broadcast retry failed for ${group.group_name}:`, retryErr.message);
        }
      } else {
        results.failed++;
        errorMsg = err.message;
        results.errors.push({ group: group.group_name, error: err.message });
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
