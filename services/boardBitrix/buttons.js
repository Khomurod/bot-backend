'use strict';

/**
 * A tap on a button under a Board ↔ Bitrix question (owner, 11 November
 * 2026): "✅ <the fix>" does it in Bitrix, "⏭ Skip" is the same as typing
 * "skip". The callback carries only the question id and an index — the action
 * itself is the one stored with the question's advice
 * (database/boardBitrixAdvice.js), so a tap can only ever mean what was shown.
 *
 * Only the people who may answer (services/boardBitrix/answer.js), only on
 * the question that is out now, and only on the message that question is.
 * Returns what to answer the tap with; never throws.
 */

const { CALLBACK_PATTERN } = require('../../lib/boardBitrix/actions');
const answer = require('./answer');
const { askNext, sayUnder } = require('./ask');

function defaultDeps() {
  /* eslint-disable global-require */
  const { runCheckPass, runExclusive } = require('./pass');
  const { withRunRecord } = require('../operations/runLedger');
  return {
    store: require('../../database/boardBitrix'),
    advice: require('../../database/boardBitrixAdvice'),
    notices: require('../../database/operationalNotifications'),
    operators: require('../../database/controlOperators'),
    recheck: (confirmId) => runExclusive(
      () => withRunRecord('board_bitrix_check', () => runCheckPass({ confirmId, ask: false }))
    ),
    askNext: () => askNext(),
    say: (args) => sayUnder(args),
    portalOrigin: require('../bitrix24DealStages').portalOrigin,
    apply: (action) => require('./apply').applyAction(action),
  };
  /* eslint-enable global-require */
}

const reply = (text, alert = false) => ({ text, alert });

/**
 * @param {{data: string, chatId, messageId, telegramUserId, fromIsBot}} press
 * @returns {Promise<{text: string, alert: boolean}>}
 */
async function handleBoardBitrixButton(press, deps = defaultDeps()) {
  const m = CALLBACK_PATTERN.exec(String(press?.data || ''));
  if (!m) return reply('This button no longer works.', true);
  if (press.fromIsBot) return reply('Only a person can answer this.', true);
  try {
    if (!(await answer.mayAnswer(press.telegramUserId, deps))) {
      return reply('You are not on the list of people who may answer these (Settings → Dispatcher Board).', true);
    }
    const question = await deps.store.getDiscrepancy(Number(m[1]));
    const notice = await deps.notices.findNoticeByTelegramMessage(press.chatId, press.messageId);
    if (!question || !notice || String(notice.subjectId) !== String(question.id)) {
      return reply('This question has changed — read the newest one.', true);
    }
    if (question.state !== 'asked') return reply('This question is not open any more.', true);

    const say = (line, lines = []) => deps.say({
      chatId: press.chatId, messageId: press.messageId, text: line, lines, key: `btn:${question.id}:${question.askCount}:${m[2]}`,
    });
    const outcome = await answer.exclusive(question.id, () => (m[2] === 's'
      ? answer.skip(question, say, deps)
      : answer.doAction(question, Number(m[2]), say, deps)));
    if (outcome === 'busy') return reply('Already working on it…');
    if (outcome === 'skipped') return reply('Skipped — next question.');
    if (outcome === 'confirmed') return reply('Done.');
    return reply('See the answer under the question.');
  } catch (err) {
    console.warn('[BOARD-BITRIX] button failed:', String(err.message).slice(0, 160));
    return reply('Something went wrong — nothing changed.', true);
  }
}

module.exports = { handleBoardBitrixButton };
