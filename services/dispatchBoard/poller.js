'use strict';

/**
 * Reading the Dispatcher Board, on a timer.
 *
 * The Board is the authority on today's assignment, and this is the only thing
 * that reads it. What it does NOT do is as important as what it does:
 *
 *   IT DECIDES NOTHING. It writes what the Board said into the snapshot and
 *   stops. Linking a row to a person, and noticing that the Board and Wenze
 *   disagree, are separate stages with their own evidence rules — a poller
 *   that also decided would put both behind one switch.
 *
 *   IT SENDS NOTHING. No Telegram message has any business coming from a
 *   spreadsheet read.
 *
 *   IT NEVER MARKS THE FLEET ABSENT ON A FAILURE. "We could not read the
 *   board" and "nobody is on the board" are opposite facts, and only the
 *   second one may retire a row. A pass that did not parse leaves the snapshot
 *   exactly as it was.
 *
 * Cost: one HTTP request per tick, default every five minutes, and nothing at
 * all until an administrator saves a URL and a token — `enabled` defaults to
 * FALSE and an unconfigured board reports `blocked`, which the run ledger
 * renders as "waiting on somebody", not as a failure.
 */
const { withRunRecord } = require('../operations/runLedger');
const { stripUrls } = require('../../lib/security/redactUrls');
const { parseBoardPayload, summariseBoardPayload } = require('../../lib/board/parse');

// The literal is repeated in the `withRunRecord` call below on purpose: the
// catalogue's observability test scans for a STRING there, and a worker that
// hid its key behind a constant would pass the scan by being unreadable.
const SERVICE_KEY = 'dispatch_board_poll';
/** A deploy settles before the first read. */
const FIRST_TICK_DELAY_MS = 60 * 1000;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    settings: require('../../database/dispatchBoardSettings'),
    store: require('../../database/dispatchBoard'),
    client: require('./client'),
  };
  /* eslint-enable global-require */
}

/**
 * One pass. Returns a summary; never throws.
 *
 * @returns {Promise<{read?:number, inserted?:number, updated?:number,
 *   unchanged?:number, absent?:number, problems?:number, blocked?:string,
 *   error?:string}>}
 */
async function runBoardPoll({ deps = defaultDeps() } = {}) {
  const summary = {};
  let config;
  try {
    config = await deps.settings.getBoardConfig();
  } catch (err) {
    // The settings read no longer swallows a database failure, so this is a
    // real outage rather than "nobody configured it". Say which.
    summary.error = `the board settings could not be read: ${stripUrls(err.message)}`;
    return summary;
  }

  if (!config.enabled) {
    summary.blocked = 'the Dispatcher Board is switched off in Settings';
    return summary;
  }
  if (!config.configured) {
    summary.blocked = 'no Dispatcher Board address and token have been saved yet';
    return summary;
  }

  let payload;
  try {
    const answer = await deps.client.fetchBoard({ baseUrl: config.baseUrl, token: config.token });
    payload = answer.json;
  } catch (err) {
    // Already URL-stripped at construction; stripped again on the way out
    // because this sentence is about to be stored.
    const message = stripUrls(err.message);
    await deps.settings.recordPollOutcome({ ok: false, error: message });
    summary.error = message;
    return summary;
  }

  const parsed = parseBoardPayload(payload);
  if (!parsed.ok) {
    const message = 'the board answered, but no rows could be found in its reply';
    await deps.settings.recordPollOutcome({ ok: false, error: message });
    summary.error = message;
    return summary;
  }

  // WHAT MAY RETIRE A ROW: AN ANSWER WITH SOMETHING IDENTIFIABLE IN IT.
  //
  // `markAbsent` with an empty keep-list retires every row, by design — that IS
  // what an empty board means. Three different answers reach that same empty
  // list without the board having emptied:
  //
  //   `{"rows": []}` — an Apps Script that hit its own error or lost its sheet
  //   still answers 200.
  //
  //   `{"rows": [{}, {}]}` — both identifying column names were renamed. The
  //   parser keeps the rows and reports them, so the COUNT is not zero, but
  //   every key is null and nulls are filtered out of the keep-list. Counting
  //   rows would have missed this; what matters is identifiable rows.
  //
  //   rows naming a truck and nobody — `driver_name_raw` is NOT NULL, so they
  //   cannot be stored and cannot hold their place either.
  //
  // Acting on any of them would retire the whole fleet's assignments on one bad
  // afternoon. So such a pass is REPORTED and changes nothing; if the board
  // really has emptied, its rows stay present with a `last_seen_at` that stops
  // moving, which is visible and reversible. The opposite mistake is not.
  const storable = parsed.rows.filter((r) => r && r.rowKey && r.driverNameRaw);
  const skipped = parsed.count - storable.length;
  if (storable.length === 0) {
    const message = parsed.count === 0
      ? 'the board answered with no rows at all — nothing was changed'
      : `the board answered with ${parsed.count} row(s), none of which could be `
        + 'identified — nothing was changed';
    await deps.settings.recordPollOutcome({ ok: false, count: parsed.count, error: message });
    summary.error = message;
    return summary;
  }

  try {
    // ONE TRANSACTION. Retiring rows only after a good read is not enough on its
    // own: a store that failed halfway would leave some rows new and the rest
    // stale. The keep-list is exactly what was stored — never what was read,
    // because a row that could not be stored cannot hold its place.
    const counts = await deps.store.applyBoardPass(storable, storable.map((r) => r.rowKey));
    Object.assign(summary, {
      read: parsed.count, skipped, ...counts, problems: parsed.problems.length,
    });
  } catch (err) {
    const message = `the board was read but could not be stored: ${stripUrls(err.message)}`;
    await deps.settings.recordPollOutcome({ ok: false, error: message });
    summary.error = message;
    return summary;
  }

  await deps.settings.recordPollOutcome({
    ok: true,
    count: parsed.count,
    boardDate: parsed.boardDate,
    generatedAt: parsed.generatedAt,
  });
  return summary;
}

let serviceTimer = null;
let serviceStopped = false;
let tickRunning = false;

async function tick(deps) {
  // Skipped, never queued: a slow board must not stack passes that would each
  // upsert the same rows.
  if (tickRunning) return;
  tickRunning = true;
  let intervalMs = DEFAULT_INTERVAL_MS;
  try {
    const summary = await withRunRecord('dispatch_board_poll', () => runBoardPoll({ deps }));
    if (summary?.read != null) {
      // `skipped` only when there is one: a row the board carries and Wenze
      // cannot store is worth a line, and a zero every five minutes is not.
      console.log(`[BOARD] read ${summary.read} row(s) — `
        + `${summary.inserted} new, ${summary.updated} changed, ${summary.absent} gone`
        + `${summary.skipped ? `, ${summary.skipped} unusable` : ''}.`);
    }
    const config = await (deps || defaultDeps()).settings.getBoardConfig().catch(() => null);
    if (config?.pollIntervalSeconds) intervalMs = config.pollIntervalSeconds * 1000;
  } catch (err) {
    console.error('[BOARD] tick error:', stripUrls(err.message));
  } finally {
    tickRunning = false;
    if (!serviceStopped) {
      serviceTimer = setTimeout(() => tick(deps), intervalMs);
      serviceTimer.unref?.();
    }
  }
}

function startDispatchBoardPoller(deps = undefined) {
  serviceStopped = false;
  console.log('[BOARD] Watching the Dispatcher Board — reads only, sends nothing.');
  serviceTimer = setTimeout(() => { if (!serviceStopped) tick(deps); }, FIRST_TICK_DELAY_MS);
  serviceTimer.unref?.();
}

function stopDispatchBoardPoller() {
  serviceStopped = true;
  if (serviceTimer) { clearTimeout(serviceTimer); serviceTimer = null; }
}

module.exports = {
  startDispatchBoardPoller,
  stopDispatchBoardPoller,
  runBoardPoll,
  defaultDeps,
  SERVICE_KEY,
  FIRST_TICK_DELAY_MS,
  DEFAULT_INTERVAL_MS,
};
