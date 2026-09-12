'use strict';

/**
 * The one place a Telegram reply can reach the control channel.
 *
 * DELIBERATELY THIN. It translates a Telegraf context into a plain object and
 * hands it on; every decision — is this ours, who is allowed, what does it
 * mean, what does it do — lives in `services/control/replyHandler.js` where it
 * can be tested without a bot. A handler that made any of those decisions here
 * would be a decision nobody could test.
 *
 * `next()` IS CALLED UNLESS THE REPLY WAS CONSUMED. Every other `bot.on('message')`
 * handler in this application calls it, and the group message pipeline
 * downstream — home time, fuel, the chat buffer — must keep seeing ordinary
 * traffic. Only a message that was an answer to one of Wenze's questions stops
 * here, because passing an answer on to the home-time parser is how a "yes"
 * becomes something else entirely.
 *
 * NOTHING IN THIS FILE OR THE MODULES BELOW IT TOUCHES SOURCE CODE. There is no
 * filesystem, no process spawn, no git. `tests/controlNoCodeAccess.test.js`
 * asserts that structurally, so the rule survives an edit that forgets it.
 */
const { handleControlReply, defaultDeps } = require('../services/control/replyHandler');
const { notify } = require('../services/notifications/send');

/**
 * Say something back, under the operator's own message.
 *
 * Through `notify` like every other human-facing line in this application, with
 * `inReplyTo` pinning it to the chat the question was asked in. The subject is
 * the REPLY, not the driver, so the burst suppressor — which groups by person —
 * can never hold an acknowledgement behind three notices about someone else.
 */
async function ackInThread({ chatId, inReplyToMessageId, text }) {
  await notify({
    category: 'needs_attention',
    title: text,
    subjectType: 'control_reply',
    subjectId: `${chatId}:${inReplyToMessageId}`,
    inReplyTo: { chatId, messageId: inReplyToMessageId },
  }).catch(() => null);
}

function registerControlReplyHandlers(bot) {
  bot.on('message', async (ctx, next) => {
    const msg = ctx.message;
    // The cheapest possible rejection, before anything is awaited: almost every
    // message in a driver group is not a reply to us.
    if (!msg || !msg.reply_to_message || !msg.text) return next();

    let result = { handled: false };
    try {
      result = await handleControlReply({
        chatId: ctx.chat?.id,
        chatType: ctx.chat?.type,
        messageId: msg.message_id,
        repliedToMessageId: msg.reply_to_message.message_id,
        text: msg.text,
        telegramUserId: ctx.from?.id,
        fromIsBot: Boolean(ctx.from?.is_bot),
      }, { ...defaultDeps(), ack: ackInThread });
    } catch (err) {
      // A control failure must never swallow a driver's message.
      console.warn('[CONTROL] handler error:', err.message);
    }

    if (result.handled) return undefined;
    return next();
  });
}

module.exports = { registerControlReplyHandlers, ackInThread };
