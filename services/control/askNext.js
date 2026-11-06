'use strict';

/**
 * The next question right after an answer — not on the next fifteen-minute
 * sweep.
 *
 * THE OWNER, 6 November 2026: "one at a time to Telegram, no daily limit".
 * With one unanswered question allowed (`max_questions_per_pass = 1`) the ask
 * pass sends nothing while a question waits, so the queue moves at the speed
 * the owner answers — and an answer should bring the next question in seconds,
 * not up to a quarter of an hour later. This runs the ordinary pass, with every
 * gate it has (the standing cap, the daily limit, the repeat window, memory),
 * shortly after an answer closes a question. Several answers in a row run it
 * once. Never throws, never holds the process open.
 */
const DELAY_MS = 15 * 1000;

let timer = null;

function defaultRun() {
  /* eslint-disable global-require */
  const { runAskPass } = require('./askPass');
  const { withRunRecord } = require('../operations/runLedger');
  /* eslint-enable global-require */
  return withRunRecord('control_ask_pass', () => runAskPass({}));
}

/** Ask the next question soon; a second call while one is pending does nothing. */
function askNextSoon({ delayMs = DELAY_MS, run = defaultRun } = {}) {
  if (timer) return false;
  timer = setTimeout(() => {
    timer = null;
    Promise.resolve().then(run).catch((err) => console.warn('[CONTROL] next question could not be asked:', err.message));
  }, delayMs);
  timer.unref?.();
  return true;
}

function cancelAskNext() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { askNextSoon, cancelAskNext, DELAY_MS };
