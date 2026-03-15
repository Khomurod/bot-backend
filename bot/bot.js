const { Telegraf, Markup } = require('telegraf');
const config = require('../config/config');
const db = require('../database/db');

if (!config.botToken) {
  console.error('[BOT] FATAL: BOT_TOKEN environment variable is not set!');
  process.exit(1);
}

if (!config.databaseUrl) {
  console.error('[BOT] FATAL: DATABASE_URL environment variable is not set!');
  process.exit(1);
}

if (!config.managementGroupId) {
  console.error('[BOT] FATAL: MANAGEMENT_GROUP_ID environment variable is not set!');
  process.exit(1);
}

const bot = new Telegraf(config.botToken);
const MANAGEMENT_GROUP_ID = config.managementGroupId;

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

// ─── Bot Startup ───
async function startBot() {
  try {
    await db.initializeDatabase();
    console.log('[BOT] Database initialized.');

    // ── 1. Detect when bot is added/removed from a group ──
    bot.on('my_chat_member', async (ctx) => {
      try {
        const chat = ctx.myChatMember.chat;
        const newStatus = ctx.myChatMember.new_chat_member.status;

        if (
          (chat.type === 'group' || chat.type === 'supergroup') &&
          (newStatus === 'member' || newStatus === 'administrator')
        ) {
          await db.upsertGroup(chat.id, chat.title);
          console.log(`[BOT] Added to group: ${chat.title} (${chat.id})`);
        }
      } catch (err) {
        console.error('[BOT] Error handling my_chat_member:', err.message);
      }
    });

    // ── 2. Register drivers on any interaction ──
    bot.use(async (ctx, next) => {
      try {
        if (ctx.from && ctx.from.id && !ctx.from.is_bot) {
          await db.upsertDriver(
            ctx.from.id,
            ctx.from.username || null,
            ctx.from.first_name || null,
            ctx.from.last_name || null
          );
        }
      } catch (err) {
        console.error('[BOT] Error registering driver:', err.message);
      }
      return next();
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

        if (!data || !data.startsWith('answer_')) return;

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
        } catch (_) {}
      }
    });

    // Launch bot
    bot.launch();
    console.log('[BOT] Telegram bot started.');

    // Graceful stop
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
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

    // Get English question text
    const englishQ = getTranslation(question.translations, 'en');
    const questionText = englishQ ? englishQ.question_text : 'Unknown question';

    // Get English option text
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

    const driverHandle = driver.username ? `@${escapeHtml(driver.username)}` : escapeHtml(`${driver.first_name || ''} ${driver.last_name || ''}`.trim());

    const message = `📋 <b>Driver Feedback</b>\n\n` +
      `<b>Group:</b> ${escapeHtml(group.group_name)}\n` +
      `<b>Driver:</b> ${driverHandle}\n\n` +
      `<b>Question:</b>\n${escapeHtml(questionText)}\n\n` +
      `<b>Answer:</b>\n${escapeHtml(optionText)}`;

    await bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, message, {
      parse_mode: 'HTML',
    });

    console.log(`[BOT] Report sent to management for driver=${driverHandle}`);
  } catch (err) {
    console.error('[BOT] Error reporting to management:', err.message);
    // Retry once after 2 seconds
    setTimeout(async () => {
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
        const driverHandle = driver.username ? `@${escapeHtml(driver.username)}` : escapeHtml(`${driver.first_name || ''} ${driver.last_name || ''}`.trim());
        const message = `📋 <b>Driver Feedback</b>\n\n<b>Group:</b> ${escapeHtml(group.group_name)}\n<b>Driver:</b> ${driverHandle}\n\n<b>Question:</b>\n${escapeHtml(questionText)}\n\n<b>Answer:</b>\n${escapeHtml(optionText)}`;
        await bot.telegram.sendMessage(MANAGEMENT_GROUP_ID, message, { parse_mode: 'HTML' });
        console.log('[BOT] Retry report sent to management.');
      } catch (retryErr) {
        console.error('[BOT] Retry failed:', retryErr.message);
      }
    }, 2000);
  }
}

// ─── Send question to all groups ───
async function sendQuestionToGroups(questionId) {
  const question = await db.getQuestionWithOptions(questionId);
  if (!question) {
    throw new Error(`Question not found: ${questionId}`);
  }

  const groups = await db.getAllGroups();
  const results = { sent: 0, failed: 0, errors: [] };

  for (const group of groups) {
    try {
      const lang = group.language || 'en';

      // Get question text in group's language
      const qTranslation = getTranslation(question.translations, lang);
      const questionText = qTranslation ? qTranslation.question_text : 'Question';

      // Build inline keyboard
      const buttons = [];
      if (question.options) {
        for (const opt of question.options) {
          const oTranslation = getTranslation(opt.translations, lang);
          const optionText = oTranslation ? oTranslation.option_text : `Option ${opt.option_order}`;
          buttons.push([
            Markup.button.callback(optionText, `answer_${questionId}_${opt.id}`),
          ]);
        }
      }

      const message = `📋 ${questionText}`;

      await bot.telegram.sendMessage(
        group.telegram_group_id,
        message,
        Markup.inlineKeyboard(buttons)
      );

      results.sent++;
      console.log(`[BOT] Question sent to group: ${group.group_name} (${group.telegram_group_id}) in ${lang}`);
    } catch (err) {
      results.failed++;
      results.errors.push({ group: group.group_name, error: err.message });
      console.error(`[BOT] Failed to send to group ${group.group_name}:`, err.message);
    }
  }

  return results;
}

// ─── Send test question to management group ───
async function sendTestQuestion(questionEn, optionsEn) {
  const buttons = optionsEn.map((text, i) => [
    Markup.button.callback(text, `test_answer_${i + 1}`),
  ]);

  const message = `🧪 <b>TEST QUESTION PREVIEW</b>\n\n${escapeHtml(questionEn)}\n\n<i>Choose an option:</i>`;

  await bot.telegram.sendMessage(
    MANAGEMENT_GROUP_ID,
    message,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons),
    }
  );

  console.log('[BOT] Test question sent to management group.');
}

// ─── Send broadcast message to all groups ───
async function sendBroadcast(messageText, parseMode) {
  const groups = await db.getAllGroups();
  const results = { sent: 0, failed: 0, errors: [] };

  for (const group of groups) {
    try {
      await bot.telegram.sendMessage(
        group.telegram_group_id,
        messageText,
        { parse_mode: parseMode }
      );
      results.sent++;
      console.log(`[BOT] Broadcast sent to: ${group.group_name} (${group.telegram_group_id})`);
    } catch (err) {
      results.failed++;
      results.errors.push({ group: group.group_name, error: err.message });
      console.error(`[BOT] Broadcast failed for ${group.group_name}:`, err.message);
    }
  }

  console.log(`[BOT] Broadcast complete: ${results.sent} sent, ${results.failed} failed`);
  return results;
}

// ─── Send broadcast test to management group ───
async function sendBroadcastTest(messageText, parseMode) {
  await bot.telegram.sendMessage(
    MANAGEMENT_GROUP_ID,
    messageText,
    { parse_mode: parseMode }
  );
  console.log('[BOT] Broadcast test sent to management group.');
}

module.exports = { bot, startBot, sendQuestionToGroups, sendTestQuestion, sendBroadcast, sendBroadcastTest };
