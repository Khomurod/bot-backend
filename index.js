/**
 * Main entry point: starts both the Telegram bot and the Express API server.
 */
const { startBot } = require('./bot/bot');
const { startServer } = require('./server/api');

// ─── Process-level error handlers ───
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
});

(async () => {
  console.log('═══════════════════════════════════════════');
  console.log('  Telegram Driver Feedback System');
  console.log('═══════════════════════════════════════════');

  // Start the Telegram bot
  await startBot();

  // Start the Express API server
  startServer();
})();
