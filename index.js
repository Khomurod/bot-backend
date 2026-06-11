/**
 * Main entry point for the dispatch and feedback hub.
 */
const { bot, startBot, stopBot } = require('./bot/bot');
const { startServer, stopServer } = require('./server/api');
const { startScheduler, stopScheduler } = require('./services/schedulerService');
const { startWeeklyReporter, stopWeeklyReporter } = require('./services/weeklyReportService');
const { startBirthdayService, stopBirthdayService } = require('./services/birthdayService');
const {
  startGroupStatusAiService,
  stopGroupStatusAiService,
} = require('./services/groupStatusAiService');
const {
  startEmployeeBirthdayWishService,
  stopEmployeeBirthdayWishService,
} = require('./services/employeeBirthdayWishService');
const {
  startBackgroundAnnotator,
  stopBackgroundAnnotator,
} = require('./services/aiAnnotationService');
const {
  configureFacebookLeadTelegram,
  startFacebookWebhookWorker,
  stopFacebookWebhookWorker,
} = require('./services/facebookWebhookService');
const {
  configureDispatchEtaTelegram,
  startDispatchEtaScheduler,
  stopDispatchEtaScheduler,
} = require('./services/dispatchEtaUpdateService');
const db = require('./database/db');

const DB_DRAIN_TIMEOUT_MS = 5000;

function isTelegramPollingConflict(err) {
  const description = err?.response?.description || err?.message || '';
  return err?.response?.error_code === 409
    || description.includes('terminated by other getUpdates request');
}

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message);
  console.error(err.stack);
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
  if (isTelegramPollingConflict(reason)) {
    console.warn('[BOT] Polling conflict detected. Waiting for retry loop to reclaim the token.');
    return;
  }
  console.error('[FATAL] Unhandled Rejection:', reason);
});

let isShuttingDown = false;
async function shutdownAll(signal = 'SIGTERM') {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[SHUTDOWN] Graceful shutdown initiated (${signal})...`);

  try { stopScheduler(); } catch (err) { console.error('[SHUTDOWN] stopScheduler failed:', err.message); }
  try { stopDispatchEtaScheduler(); } catch (err) { console.error('[SHUTDOWN] stopDispatchEtaScheduler failed:', err.message); }
  try { stopBirthdayService(); } catch (err) { console.error('[SHUTDOWN] stopBirthdayService failed:', err.message); }
  try { stopEmployeeBirthdayWishService(); } catch (err) { console.error('[SHUTDOWN] stopEmployeeBirthdayWishService failed:', err.message); }
  try { stopGroupStatusAiService(); } catch (err) { console.error('[SHUTDOWN] stopGroupStatusAiService failed:', err.message); }
  try { stopWeeklyReporter(); } catch (err) { console.error('[SHUTDOWN] stopWeeklyReporter failed:', err.message); }
  try { stopBackgroundAnnotator(); } catch (err) { console.error('[SHUTDOWN] stopBackgroundAnnotator failed:', err.message); }
  try { stopFacebookWebhookWorker(); } catch (err) { console.error('[SHUTDOWN] stopFacebookWebhookWorker failed:', err.message); }
  try { stopBot(signal); } catch (err) { console.error('[SHUTDOWN] stopBot failed:', err.message); }
  try { await stopServer(); } catch (err) { console.error('[SHUTDOWN] stopServer failed:', err.message); }

  try {
    await Promise.race([
      db.pool.end(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('pool.end() timeout')),
        DB_DRAIN_TIMEOUT_MS,
      )),
    ]);
    console.log('[SHUTDOWN] Database pool drained.');
  } catch (err) {
    console.error('[SHUTDOWN] Error draining pool:', err.message);
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdownAll('SIGINT'));
process.on('SIGTERM', () => shutdownAll('SIGTERM'));

(async () => {
  console.log('===========================================');
  console.log('  Telegram Driver Feedback System');
  console.log('===========================================');

  try {
    await db.initializeDatabase();
  } catch (err) {
    console.error('[BOOT] Database initialization failed; aborting startup:', err.message);
    process.exit(1);
  }

  configureDispatchEtaTelegram(bot.telegram);
  const { getLeadsTelegram } = require('./services/leadsTelegramClient');
  configureFacebookLeadTelegram(getLeadsTelegram());
  console.log('[BOOT] Facebook lead Telegram delivery uses TELEGRAM_BOT_TOKEN (WenzeLeadBots).');

  startServer();
  await startBot();

  startScheduler();
  startDispatchEtaScheduler();
  startBirthdayService();
  startEmployeeBirthdayWishService();
  startGroupStatusAiService();
  startWeeklyReporter();
  startBackgroundAnnotator();
  startFacebookWebhookWorker();
})();
