const { handleRoastMessage } = require('../services/roastService');

function registerRoastHandlers(bot) {
  bot.on('message', async (ctx, next) => {
    try {
      await handleRoastMessage(ctx);
    } catch (err) {
      console.error('[ROAST] Handler error:', err.message);
    }
    return next();
  });
  console.log('[ROAST] Handlers registered.');
}

module.exports = { registerRoastHandlers };
