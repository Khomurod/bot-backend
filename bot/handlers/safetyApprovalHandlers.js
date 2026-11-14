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
 * approved" is exactly the edit that must be read again — and a recruiter
 * adding the phone to a lead's post is the edit a later tag reads.
 *
 * THE BOT ITSELF (ctx.botInfo: its id and username, from Telegram at start)
 * and the Telegram client go along, so a reply that mentions the bot can be
 * recognised — never by a username written in code — and answered with a
 * reaction (services/hiringStages/requestQueue.js).
 */

const { captureSafetyApprovalMessage } = require('../../services/safetyApprovals/captureService');

function registerSafetyApprovalHandlers(bot) {
  bot.on('message', async (ctx, next) => {
    try {
      await captureSafetyApprovalMessage(ctx.message, { botInfo: ctx.botInfo, telegram: ctx.telegram });
    } catch (err) {
      console.error('[SAFETY APPROVALS] handler failed:', err.message);
    }
    return next();
  });

  bot.on('edited_message', async (ctx, next) => {
    try {
      await captureSafetyApprovalMessage(ctx.editedMessage || ctx.update?.edited_message, {
        botInfo: ctx.botInfo, telegram: ctx.telegram,
      });
    } catch (err) {
      console.error('[SAFETY APPROVALS] edit handler failed:', err.message);
    }
    return next();
  });
}

module.exports = { registerSafetyApprovalHandlers };
