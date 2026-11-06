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
 *
 * SEEN, AND RETRIED. Each read is recorded in the run ledger
 * (`fleet_crosscheck_datatruck_read`: ok / blocked while Datatruck has no token /
 * error with the reason), so Health says whether the check has a read at all —
 * on 6 November 2026 the first deploy ran four hours with no question filed and
 * nothing anywhere to say why. A read that fails is tried again after
 * `RETRY_AFTER_MS` rather than a day later.
 */
const { readDatatruck, ORDER_DAYS } = require('./datatruckRead');

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_READ_DELAY_MS = 30 * 1000;
const STALE_AFTER_MS = 2 * DAY_MS;
const RETRY_AFTER_MS = 30 * 60 * 1000;
const SERVICE_KEY = 'fleet_crosscheck_datatruck_read';

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    datatruck: require('../datatruckApiService'),
    now: () => Date.now(),
    withRunRecord: require('../operations/runLedger').withRunRecord,
  };
  /* eslint-enable global-require */
}

function createDailyRead(deps = defaultDeps()) {
  let good = null;      // { readAt, drivers, orders }
  let lastFailure = null;
  let running = null;
  let timer = null;
  let retry = null;
  const withRunRecord = deps.withRunRecord || ((key, pass) => pass());

  async function readOnce() {
    const nowMs = deps.now();
    const dt = await readDatatruck(deps.datatruck, nowMs);
    if (dt.read) {
      good = { readAt: new Date(nowMs).toISOString(), drivers: dt.drivers, orders: dt.orders, orderDays: ORDER_DAYS };
      lastFailure = null;
      return { read: true, drivers: dt.drivers.length, orders: dt.orders.length };
    }
    lastFailure = { at: new Date(nowMs).toISOString(), reason: dt.reason };
    console.warn('[FLEET-CROSSCHECK] daily Datatruck read did not complete:', dt.reason);
    // Not connected is waiting on configuration, not a failure (runLedger.js).
    if (!deps.datatruck.isConfigured()) return { read: false, blocked: dt.reason };
    scheduleRetry();
    return { read: false, error: dt.reason };
  }

  function scheduleRetry() {
    if (retry) return;
    retry = setTimeout(() => { retry = null; refresh().catch(() => {}); }, RETRY_AFTER_MS);
    retry.unref?.();
  }

  /** Read Datatruck now. One read at a time; a second caller waits for the first. */
  async function refresh() {
    if (!running) {
      running = Promise.resolve()
        // The key written out, not SERVICE_KEY: the catalog test reads it here.
        .then(() => withRunRecord('fleet_crosscheck_datatruck_read', readOnce))
        .then((summary) => Boolean(summary?.read))
        .finally(() => { running = null; });
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
    if (retry) clearTimeout(retry);
    timer = null;
    retry = null;
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
  createDailyRead, dailyRead, DAY_MS, STALE_AFTER_MS, RETRY_AFTER_MS, SERVICE_KEY,
};
