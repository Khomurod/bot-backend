'use strict';

/**
 * The Board ↔ Bitrix check, one pass: read the Dispatcher Board snapshot and
 * Bitrix, compare (lib/boardBitrix/compare.js), record what differs, resolve
 * what no longer does, and ask the next question if none is out.
 *
 * THE BOARD IS THE SOURCE OF TRUTH; BITRIX IS ONLY READ. Nothing here writes
 * to Bitrix or to the Board — a person corrects Bitrix and says "done".
 *
 * NOTHING IS DECIDED FROM AN INCOMPLETE READ. Each of these stops the pass
 * before the queue is touched, so a bad afternoon cannot resolve every open
 * question or file a hundred new ones:
 *   - the Board feed is off (blocked) or has not been read successfully lately
 *     (error) — its snapshot may be hours old;
 *   - the snapshot names nobody, may be cut off, or Bitrix returns no active
 *     driver;
 *   - any Bitrix page fails, the list is longer than one pass reads, or a field
 *     the comparison needs is gone (services/boardBitrix/bitrixRead.js).
 *
 * Passes never overlap: the timer and the re-check after "done" both go
 * through `runExclusive`.
 */

const { compareBoardWithBitrix } = require('../../lib/boardBitrix/compare');
const { askNext, sayUnder } = require('./ask');

/**
 * The Board snapshot must have been read within max(30 minutes, twice its own
 * poll interval + 5 minutes) — see `boardFreshnessMs`.
 */
const MIN_BOARD_FRESHNESS_MS = 30 * 60 * 1000;
/** More present Board lines than this and the read may be cut off — a failure, not a list. */
const BOARD_ROW_LIMIT = 5000;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    store: require('../../database/boardBitrix'),
    boardConfig: require('../../database/dispatchBoardSettings').getBoardConfig,
    boardRows: () => require('../../database/dispatchBoard').listBoardRows({ presentOnly: true, limit: BOARD_ROW_LIMIT }),
    readBitrix: () => require('./bitrixRead').readBitrix(),
    askNext: () => askNext(),
    sayUnder: (args) => sayUnder(args),
    now: () => Date.now(),
  };
  /* eslint-enable global-require */
}

function boardFreshnessMs(cfg) {
  return Math.max(MIN_BOARD_FRESHNESS_MS, 2 * 1000 * (Number(cfg.pollIntervalSeconds) || 300) + 5 * 60 * 1000);
}

/** Why the Board cannot be compared with right now, as a ledger summary, or null. */
function boardProblem(cfg, now) {
  if (!cfg.enabled || !cfg.configured) {
    return { blocked: 'the Dispatcher Board feed is not switched on (Settings → Dispatcher Board), so there is nothing to compare Bitrix with' };
  }
  const lastAt = cfg.lastPollAt ? new Date(cfg.lastPollAt).getTime() : NaN;
  if (cfg.lastPollOk !== true || !Number.isFinite(lastAt) || now - lastAt > boardFreshnessMs(cfg)) {
    return { error: 'the Dispatcher Board has not been read successfully lately — nothing was compared' };
  }
  return null;
}

/**
 * @param {{ deps?: object, confirmId?: number, ask?: boolean }} [opts]
 *   confirmId — the question the owner said "done" to (resolved as confirmed);
 *   ask — ask the next question at the end (the re-check asks it itself, after
 *   its own confirmation, so the order in the chat is right)
 * @returns {Promise<object>} a ledger summary; never throws
 */
async function runCheckPass({ deps = defaultDeps(), confirmId = null, ask = true } = {}) {
  let settings;
  try {
    settings = await deps.store.getSettings();
  } catch (err) {
    return { error: `the check's switch could not be read: ${String(err.message).slice(0, 200)}` };
  }
  if (!settings.enabled) return { blocked: 'the Board ↔ Bitrix check is switched off (Settings → Dispatcher Board)' };

  let rows;
  try {
    const problem = boardProblem(await deps.boardConfig(), deps.now());
    if (problem) return problem;
    rows = await deps.boardRows();
    if (rows.length >= BOARD_ROW_LIMIT) {
      return { error: `the Dispatcher Board snapshot has ${BOARD_ROW_LIMIT} or more lines and may be cut off — nothing was compared` };
    }
  } catch (err) {
    return { error: `the Dispatcher Board snapshot could not be read: ${String(err.message).slice(0, 200)}` };
  }

  let bitrix;
  try {
    bitrix = await deps.readBitrix();
  } catch (err) {
    if (err?.reason === 'not_configured') return { blocked: 'Bitrix24 is not connected (Settings → RingCentral → Bitrix24)' };
    return { error: `Bitrix could not be read: ${String(err.message).slice(0, 200)}` };
  }

  const result = compareBoardWithBitrix({ boardRows: rows, deals: bitrix.deals, trucks: bitrix.trucks });
  if (!result.counts.boardPeople) return { error: 'the Dispatcher Board snapshot names no drivers — nothing was compared' };
  if (!result.counts.activeDeals) return { error: 'Bitrix returned no active driver in DRIVER RELATION — nothing was compared' };

  let applied;
  try {
    applied = await deps.store.applyPass(result.discrepancies, { confirmId });
  } catch (err) {
    return { error: `the differences could not be recorded: ${String(err.message).slice(0, 200)}` };
  }

  // The question out was fixed without a reply: say so under it, then move on.
  for (const r of applied.resolved.filter((x) => x.wasAsked && x.id !== confirmId)) {
    // eslint-disable-next-line no-await-in-loop
    const where = await deps.store.questionMessage(r.questionNoticeId).catch(() => null);
    // eslint-disable-next-line no-await-in-loop
    await deps.sayUnder({
      chatId: where?.chatId, messageId: where?.messageId,
      text: '✅ Fixed — Bitrix matches the Dispatcher Board now.',
      key: `fixed:${r.id}:${r.askCount}`,
    });
  }

  const asked = ask ? await deps.askNext() : null;
  return {
    ...result.counts,
    opened: applied.opened.length,
    reopened: applied.reopened.length,
    resolved: applied.resolved.length,
    asked: asked?.asked === true,
  };
}

// ── never two at once ────────────────────────────────────────────────────────

let chain = Promise.resolve();

/** Run `fn` after every pass already queued; one at a time in this process. */
function runExclusive(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

module.exports = { runCheckPass, runExclusive, boardProblem, defaultDeps };
