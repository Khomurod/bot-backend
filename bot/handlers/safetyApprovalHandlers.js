'use strict';

/**
 * The one place a recruiting-group message reaches Safety Approvals.
 *
 * DELIBERATELY THIN: whether this is the right chat, who is Safety and what
 * to queue are decided in services/safetyApprovals/captureService.js, where
 * they can be tested without a bot.
 *
 * `next()` IS ALWAYS CALLED. Capture is an observer and never consumes a
 * message. IT CANNOT THROW: a rejection inside a `bot.on('message')` handler
 * reaches index.js's `unhandledRejection` hook, which exits the process.
 *
 * EDITED MESSAGES ARE CAPTURED TOO: Safety correcting "approved" to "not
 * approved" is exactly the edit that must be read again.
 */

const { captureSafetyApprovalMessage } = require('../../services/safetyApprovals/captureService');

function registerSafetyApprovalHandlers(bot) {
  bot.on('message', async (ctx, next) => {
    try {
      await captureSafetyApprovalMessage(ctx.message);
    } catch (err) {
      console.error('[SAFETY APPROVALS] handler failed:', err.message);
    }
    return next();
  });

  bot.on('edited_message', async (ctx, next) => {
    try {
      await captureSafetyApprovalMessage(ctx.editedMessage || ctx.update?.edited_message);
    } catch (err) {
      console.error('[SAFETY APPROVALS] edit handler failed:', err.message);
    }
    return next();
  });
}

module.exports = { registerSafetyApprovalHandlers };
