'use strict';

/**
 * The owner's typed answer to one of Wenze's learning questions.
 *
 * DELIBERATELY THIN, like bot/controlReplyHandlers.js: every decision — is this
 * ours, who may answer, what is kept — lives in services/ai/learning/answer.js
 * where it can be tested without a bot.
 *
 * Registered right after the control channel's reply handler: a learning
 * question carries no `question_json`, so the control handler passes the reply
 * on, and this one takes it. Anything that is not an answer to one of our
 * questions falls through untouched.
 */
const { handleLessonReply, defaultDeps } = require('../../services/ai/learning/answer');
const { notify } = require('../../services/notifications/send');

/** "Understood: … Saved", under the owner's own message. */
async function ackLesson({ chatId, inReplyToMessageId, text }) {
  await notify({
    category: 'ai_learning',
    title: text,
    subjectType: 'ai_learning_reply',
    subjectId: `${chatId}:${inReplyToMessageId}`,
    inReplyTo: { chatId, messageId: inReplyToMessageId },
  }).catch(() => null);
}

function nameOf(from) {
  if (!from) return null;
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || (from.username ? `@${from.username}` : null);
}

function registerLessonReplyHandlers(bot) {
  bot.on('message', async (ctx, next) => {
    const msg = ctx.message;
    if (!msg || !msg.reply_to_message || !msg.text) return next();
    let result = { handled: false };
    try {
      result = await handleLessonReply({
        chatId: ctx.chat?.id,
        chatType: ctx.chat?.type,
        messageId: msg.message_id,
        repliedToMessageId: msg.reply_to_message.message_id,
        text: msg.text,
        telegramUserId: ctx.from?.id,
        fromIsBot: Boolean(ctx.from?.is_bot),
        fromName: nameOf(ctx.from),
      }, { ...defaultDeps(), ack: ackLesson });
    } catch (err) {
      console.warn('[AI LEARNING] handler error:', err.message);
    }
    if (result.handled) return undefined;
    return next();
  });
}

module.exports = { registerLessonReplyHandlers, ackLesson };
