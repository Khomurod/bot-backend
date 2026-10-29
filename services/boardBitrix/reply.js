'use strict';

/**
 * The owner's reply to a Board ↔ Bitrix question.
 *
 * THE GATES, cheapest first, the order the control channel and the AI
 * learning questions use:
 *
 *   1. shape      a group, not a bot, a reply, some text — no database read
 *   2. is it ours the replied-to message is one of OUR questions
 *                 (subject `board_bitrix_question`)
 *   3. WHO        the control channel's allow-list (`control_operators`).
 *                 Being in the group is not permission; a stranger's reply is
 *                 consumed and never acted on or answered
 *   4. still out  the question is the one asked now
 *   5. once       `claimReply` — Telegram redelivers, and a reply already
 *                 handled is ignored
 *
 * Then: "done" re-reads Bitrix at once (a full pass, never overlapping the
 * timer's) and either confirms and asks the next question, or says what is
 * still different. "skip" puts it back for a day and asks the next. Anything
 * else gets one line saying what to type. No model reads these replies.
 *
 * Bitrix is never written: "done" means a person changed it.
 */

const { readReply } = require('../../lib/boardBitrix/replyIntent');
const { factsFor } = require('../../lib/boardBitrix/wording');
const { SUBJECT_TYPE, askNext, sayUnder, linksFor } = require('./ask');

const GROUP_TYPES = new Set(['group', 'supergroup']);
const SKIP_HOURS = 24;

function defaultDeps() {
  /* eslint-disable global-require */
  const { runCheckPass, runExclusive } = require('./pass');
  const { withRunRecord } = require('../operations/runLedger');
  return {
    store: require('../../database/boardBitrix'),
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

    if (!(await deps.operators.isControlOperator(telegramUserId))) {
      return { handled: true, outcome: 'ignored_unauthorised' };
    }
    const say = (line, lines = []) => deps.say({ chatId, messageId, text: line, lines, key: `${chatId}:${messageId}` });

    if (question.state === 'resolved') {
      await say('That one is already fixed — Bitrix matches the Dispatcher Board. Thank you!');
      return { handled: true, outcome: 'already_fixed' };
    }
    if (question.state !== 'asked') {
      await say('That question is not open right now — I will ask it again later.');
      return { handled: true, outcome: 'not_open' };
    }
    if (!(await deps.store.claimReply(question.id, messageId, telegramUserId))) {
      return { handled: true, outcome: 'duplicate' };
    }

    const intent = readReply(words);
    if (intent === 'skip') {
      if (!(await deps.store.snooze(question.id, SKIP_HOURS))) return { handled: true, outcome: 'already_moved' };
      await say('Skipped — I will come back to it tomorrow.');
      await deps.askNext();
      return { handled: true, outcome: 'skipped' };
    }
    if (intent !== 'done') {
      await say('Fix it in Bitrix, then reply "done" to the question and I will check again. Reply "skip" to come back to it tomorrow.');
      return { handled: true, outcome: 'unclear' };
    }

    const summary = await deps.recheck(question.id);
    if (!summary || summary.error || summary.blocked) {
      await say(`I could not check Bitrix just now (${String(summary?.error || summary?.blocked || 'no answer').slice(0, 160)}). `
        + 'I will check again on the next pass.');
      return { handled: true, outcome: 'recheck_failed' };
    }
    const now = await deps.store.getDiscrepancy(question.id);
    // The timer's pass, queued ahead of this re-check, saw the fix first: it
    // has already said "Fixed" under the question and asked the next one. A
    // second confirmation after that would arrive out of order.
    if (now && now.state === 'resolved' && now.resolvedHow === 'seen_fixed') {
      return { handled: true, outcome: 'fixed_meanwhile' };
    }
    if (!now || now.state === 'resolved') {
      await say('✅ Confirmed — Bitrix matches the Dispatcher Board now. Thank you!');
      await deps.askNext();
      return { handled: true, outcome: 'confirmed' };
    }
    const origin = await Promise.resolve(deps.portalOrigin()).catch(() => null);
    await say('Still different:', [
      ...factsFor(now.details, linksFor(origin)),
      'Reply "done" again once it is fixed. If you changed the Dispatcher Board instead, I re-read it every few minutes.',
    ]);
    return { handled: true, outcome: 'still_different' };
  } catch (err) {
    console.warn('[BOARD-BITRIX] reply handling failed:', String(err.message).slice(0, 200));
    return { handled: false, reason: 'error' };
  }
}

module.exports = { handleBoardBitrixReply, defaultDeps };
