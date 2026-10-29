'use strict';

/**
 * The Board ↔ Bitrix check on a timer: every fifteen minutes, the first pass
 * five minutes after boot (a deploy settles, and the Board feed reads first).
 * `board_bitrix_check` in the background roster; stood down in economy mode
 * with the other automatic checks and their questions (lib/operations/economyMode.js).
 *
 * `runNow` is what Settings uses: switching the check on runs a pass at once,
 * so the first question does not wait a quarter of an hour.
 */

const { withRunRecord } = require('../operations/runLedger');
const { runCheckPass, runExclusive } = require('./pass');

const FIRST_TICK_DELAY_MS = 5 * 60 * 1000;
const POLL_MS = 15 * 60 * 1000;

let timer = null;
let stopped = true;

/** One recorded pass, never overlapping another. Never throws. */
function runNow() {
  return runExclusive(async () => {
    try {
      const summary = await withRunRecord('board_bitrix_check', () => runCheckPass());
      if (summary?.opened || summary?.resolved || summary?.reopened) {
        console.log(`[BOARD-BITRIX] ${summary.discrepancies} difference(s): ${summary.opened} new, `
          + `${summary.reopened} back again, ${summary.resolved} fixed.`);
      }
      return summary;
    } catch (err) {
      console.error('[BOARD-BITRIX] pass error:', String(err.message).slice(0, 300));
      return { error: err.message };
    }
  });
}

async function tick() {
  await runNow();
  if (!stopped) {
    timer = setTimeout(tick, POLL_MS);
    timer.unref?.();
  }
}

function startBoardBitrixCheck() {
  stopped = false;
  timer = setTimeout(() => { if (!stopped) tick(); }, FIRST_TICK_DELAY_MS);
  timer.unref?.();
}

function stopBoardBitrixCheck() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { runNow, startBoardBitrixCheck, stopBoardBitrixCheck, POLL_MS };
