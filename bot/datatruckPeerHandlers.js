const { handleDatatruckPeerMessage } = require('../services/datatruckPeerBotService');

function registerDatatruckPeerHandlers(bot) {
  bot.on('message', async (ctx, next) => {
    try {
      await handleDatatruckPeerMessage(ctx);
    } catch (err) {
      console.error('[DATATRUCK-PEER] Handler error:', err.message);
    }
    return next();
  });
  console.log('[DATATRUCK-PEER] Peer bot handlers registered.');
}

module.exports = { registerDatatruckPeerHandlers };
