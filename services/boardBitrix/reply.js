'use strict';

/**
 * A person's reply to a Board ↔ Bitrix question.
 *
 * THE GATES, cheapest first, the order the control channel and the AI
 * learning questions use:
 *
 *   1. shape      a group, not a bot, a reply, some text — no database read
 *   2. is it ours the replied-to message is one of OUR questions
 *                 (subject `board_bitrix_question`)
 *   3. WHO        the control channel's operators, or the people listed in
 *                 Settings → Dispatcher Board as allowed to answer
 *                 (services/boardBitrix/answer.js). Being in the group is not
 *                 permission; a stranger's reply is consumed and never acted on
 *   4. still out  the question is the one asked now
 *   5. once       `claimReply` — Telegram redelivers, and a reply already
 *                 handled is ignored
 *
 * Then "done" re-reads Bitrix; "skip" puts it back for a day and asks the
 * next. Anything else is read by a model with the question's facts
 * (services/boardBitrix/advice.js `readReplyWithAi`, owner 11 November 2026):
 * it may turn out to be "done", "skip", "do action N" (the same as tapping
 * that button), or information — then the bot answers in a sentence what it
 * means for the fix. Without a model, the reply gets the hint it always got.
 */

const { readReply } = require('../../lib/boardBitrix/replyIntent');
const { SUBJECT_TYPE, askNext, sayUnder } = require('./ask');
const answer = require('./answer');

const GROUP_TYPES = new Set(['group', 'supergroup']);
const HINT = 'Fix it in Bitrix (or tap a button under the question), then reply "done" and I will check again. '
  + 'Reply "skip" to come back to it tomorrow.';

function defaultDeps() {
  /* eslint-disable global-require */
  const { runCheckPass, runExclusive } = require('./pass');
  const { withRunRecord } = require('../operations/runLedger');
  return {
    store: require('../../database/boardBitrix'),
    advice: require('../../database/boardBitrixAdvice'),
    notices: require('../../database/operationalNotifications'),
    operators: require('../../database/controlOperators'),
    // A full pass, recorded like the timer's and never overlapping it. The
    // next question is asked by the caller AFTER its confirmation.
    recheck: (confirmId) => runExclusive(
      () => withRunRecord('board_bitrix_check', () => runCheckPass({ confirmId, ask: false }))
    ),
    askNext: () => askNext(),
    say: (args) => sayUnder(args),
    portalOrigin: require('../bitrix24DealStages').portalOrigin,
    apply: (action) => require('./apply').applyAction(action),
    readWithAi: (args) => require('./advice').readReplyWithAi(args),
  };
  /* eslint-enable global-require */
}

/**
 * @param {object} reply { chatId, chatType, messageId, repliedToMessageId, text, telegramUserId, fromIsBot }
 * @returns {Promise<{handled: boolean, outcome?: string, reason?: string}>} never throws
 */
async function handleBoardBitrixReply(reply, deps = defaultDeps()) {
  const {
    chatId, chatType, messageId, repliedToMessageId, text, telegramUserId, fromIsBot,
  } = reply || {};
  if (!GROUP_TYPES.has(chatType) || fromIsBot) return { handled: false, reason: 'not_ours' };
  if (repliedToMessageId == null || messageId == null || chatId == null) return { handled: false, reason: 'not_a_reply' };
  const words = String(text || '').trim();
  if (!words) return { handled: false, reason: 'no_text' };

  try {
    const notice = await deps.notices.findNoticeByTelegramMessage(chatId, repliedToMessageId);
    if (!notice || notice.subjectType !== SUBJECT_TYPE) return { handled: false, reason: 'not_a_question' };
    const question = await deps.store.getDiscrepancy(Number(notice.subjectId));
    if (!question) return { handled: false, reason: 'unknown_question' };

    if (!(await answer.mayAnswer(telegramUserId, deps))) return { handled: true, outcome: 'ignored_unauthorised' };
    const say = (line, lines = []) => deps.say({ chatId, messageId, text: line, lines, key: `${chatId}:${messageId}` });

    if (question.state === 'resolved') {
      await say('That one is already fixed — Bitrix matches the Dispatcher Board now. Thank you!');
      return { handled: true, outcome: 'already_fixed' };
    }
    if (question.state !== 'asked') {
      await say('That question is not open right now — I will ask it again later.');
      return { handled: true, outcome: 'not_open' };
    }
    if (!(await deps.store.claimReply(question.id, messageId, telegramUserId))) {
      return { handled: true, outcome: 'duplicate' };
    }

    const outcome = await answer.exclusive(question.id, async () => {
      let intent = readReply(words);
      let read = null;
      if (intent !== 'skip' && intent !== 'done') {
        read = await deps.readWithAi({ details: question.details, advice: await deps.advice.getAdvice(question.id), text: words });
        intent = read?.intent || 'unclear';
      }
      if (intent === 'skip') return answer.skip(question, say, deps);
      if (intent === 'done') return answer.recheck(question, say, deps);
      if (intent === 'do') return answer.doAction(question, read.action, say, deps);
      await say(read?.answer || HINT, read?.answer ? [HINT] : []);
      return read?.answer ? 'answered' : 'unclear';
    });
    return { handled: true, outcome };
  } catch (err) {
    console.warn('[BOARD-BITRIX] reply handling failed:', String(err.message).slice(0, 200));
    return { handled: false, reason: 'error' };
  }
}

module.exports = { handleBoardBitrixReply };
