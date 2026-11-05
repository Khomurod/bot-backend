'use strict';

/**
 * Datatruck, read once a day for the daily Board ↔ Wenze ↔ Datatruck check
 * (`services/operations/checks/fleetCrossCheck.js`). The owner's request of
 * 5 November 2026: "check B" — every day, compare the three and ask precise
 * questions.
 *
 * WHY ONCE A DAY, AND WHY IN MEMORY. The sweep runs every fifteen minutes; it
 * must not ask Datatruck every fifteen minutes, because Datatruck's allowance
 * (20 requests a minute) is shared with the Gross Grand Prix
 * (`docs/architecture/gross-race.md`). A driver list and a week of orders —
 * a handful of pages — is read at boot and then once every 24 hours, and the
 * sweep compares the live board and live Wenze against that read. Nothing is
 * written to the database: what Datatruck said is a day-old reading, not a
 * record, and after a restart the first read comes back within a minute.
 *
 * NULL MEANS "NOT READ". `latest()` is null until a read has succeeded, and
 * the check refuses to run on null — so a Datatruck that cannot be read keeps
 * the open questions where they are instead of resolving them as though the
 * three sources had come to agree. A failed read keeps the previous good one
 * for up to `STALE_AFTER_MS`, then gives it up: a three-day-old Datatruck is no
 * longer a third vote worth asking anyone about.
 */
const { readDatatruck, ORDER_DAYS } = require('./datatruckRead');

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_READ_DELAY_MS = 30 * 1000;
const STALE_AFTER_MS = 2 * DAY_MS;

function defaultDeps() {
  /* eslint-disable global-require */
  return { datatruck: require('../datatruckApiService'), now: () => Date.now() };
  /* eslint-enable global-require */
}

function createDailyRead(deps = defaultDeps()) {
  let good = null;      // { readAt, drivers, orders }
  let lastFailure = null;
  let running = null;
  let timer = null;

  /** Read Datatruck now. One read at a time; a second caller waits for the first. */
  async function refresh() {
    if (!running) {
      running = (async () => {
        const nowMs = deps.now();
        const dt = await readDatatruck(deps.datatruck, nowMs);
        if (dt.read) {
          good = { readAt: new Date(nowMs).toISOString(), drivers: dt.drivers, orders: dt.orders, orderDays: ORDER_DAYS };
          lastFailure = null;
        } else {
          lastFailure = { at: new Date(nowMs).toISOString(), reason: dt.reason };
          console.warn('[FLEET-CROSSCHECK] daily Datatruck read did not complete:', dt.reason);
        }
        return dt.read;
      })().finally(() => { running = null; });
    }
    return running;
  }

  /** The last good read while it is fresh enough to vote; null otherwise. */
  function latest() {
    if (!good) return null;
    if (deps.now() - Date.parse(good.readAt) > STALE_AFTER_MS) return null;
    return good;
  }

  function status() {
    return { readAt: good?.readAt || null, lastFailure, stale: Boolean(good) && !latest() };
  }

  /** Read soon after boot, then every 24 hours. The timers never hold the process open. */
  function start({ firstDelayMs = FIRST_READ_DELAY_MS, intervalMs = DAY_MS } = {}) {
    if (timer) return;
    const first = setTimeout(() => { refresh().catch(() => {}); }, firstDelayMs);
    first.unref?.();
    timer = setInterval(() => { refresh().catch(() => {}); }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { refresh, latest, status, start, stop };
}

// The process's one daily read, created on first use so that requiring this
// module (the sweep's snapshot loader does) never reaches the Datatruck client.
let shared = null;
function dailyRead() {
  if (!shared) shared = createDailyRead();
  return shared;
}

module.exports = {
  createDailyRead, dailyRead, DAY_MS, STALE_AFTER_MS,
};
