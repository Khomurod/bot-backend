'use strict';

/**
 * The one place a finance-group message reaches the Finance Monitor.
 *
 * DELIBERATELY THIN, for the same reason `bot/controlReplyHandlers.js` is: it
 * translates a Telegraf context into a plain object and hands it on. Whether
 * this is even the right chat, what the message says, and whether it repeats an
 * earlier code are all decided in `services/finance/captureService.js`, where
 * they can be tested without a bot.
 *
 * `next()` IS ALWAYS CALLED. Unlike the control channel, nothing here ever
 * consumes a message: capture is an observer, and the group message pipeline
 * downstream must keep seeing every message exactly as it did before. A finance
 * group that is also a driver group — which nobody has forbidden — must not
 * lose its other handling because this one looked at it first.
 *
 * IT CANNOT THROW. `captureFinanceMessage` returns a reason instead of
 * throwing, and this adds a catch on top, because a rejection inside a
 * `bot.on('message')` handler reaches index.js's `unhandledRejection` hook,
 * which calls `process.exit(1)`. A payment log is not worth the bot.
 *
 * EDITED MESSAGES ARE CAPTURED TOO. An edit is what the group now says, and a
 * money code corrected after the fact is exactly the case a ledger exists for.
 */
const { captureFinanceMessage } = require('../../services/finance/captureService');

function registerFinanceCaptureHandlers(bot) {
  bot.on('message', async (ctx, next) => {
    try {
      await captureFinanceMessage(ctx.message);
    } catch (err) {
      // captureFinanceMessage already contains its own failures; this is the
      // belt on top of the braces, and it logs no message text.
      console.error('[FINANCE CAPTURE] handler failed:', err.message);
    }
    return next();
  });

  bot.on('edited_message', async (ctx, next) => {
    try {
      await captureFinanceMessage(ctx.editedMessage || ctx.update?.edited_message, { isEdit: true });
    } catch (err) {
      console.error('[FINANCE CAPTURE] edit handler failed:', err.message);
    }
    return next();
  });
}

module.exports = { registerFinanceCaptureHandlers };
