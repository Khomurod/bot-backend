const { handleDatatruckPeerMessage } = require('../services/datatruckPeerBotService');

function registerDatatruckPeerHandlers(bot) {
  bot.on('message', async (ctx, next) => {
    try {
      const result = await handleDatatruckPeerMessage(ctx);
      if (ctx.from?.is_bot && !result?.handled) {
        console.log(
          `[DATATRUCK-PEER] Skipped bot message: reason=${result?.reason} `
          + `from=@${ctx.from?.username || 'unknown'} chat=${ctx.chat?.id} `
          + `text="${String(ctx.message?.text || ctx.message?.caption || '').slice(0, 60)}"`
        );
      }
    } catch (err) {
      console.error('[DATATRUCK-PEER] Handler error:', err.message);
    }
    return next();
  });
  console.log('[DATATRUCK-PEER] Peer bot handlers registered.');
}

module.exports = { registerDatatruckPeerHandlers };
