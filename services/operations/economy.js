'use strict';

/**
 * Economy mode at runtime: the environment and the clock fed to the pure rule
 * in lib/operations/economyMode.js, plus the one piece of state it needs — the
 * services that were not started and the timer that starts them.
 *
 * TWO WAYS A PAUSED PASS STANDS DOWN, because the roster has two shapes:
 *
 *   A SERVICE WHOSE EVERY PASS IS PAUSED is not started at all
 *   (`launchUnlessPaused`). No timer, no wake, no listener — nothing that could
 *   reach the database. When the date passes, `scheduleEconomyEnd` starts them.
 *
 *   A PASS THAT SHARES A TIMER WITH WORK THAT KEEPS RUNNING — the consistency
 *   sweep rides the same tick as the notification drain, the decision grading
 *   rides the scheduler — is refused inside `withRunRecord`
 *   (services/operations/runLedger.js) before its first query.
 *
 * Owned here and nowhere else: `deferred` and `endTimer`. Nothing outside this
 * file mutates either.
 */
const {
  resolveEconomy, economyPauseReason, economyIntervalMs, isEconomyPausedKey, ECONOMY_PAUSED_KEYS,
} = require('../../lib/operations/economyMode');

/** setTimeout's own ceiling; a longer wait is taken in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/**
 * When this process started — the moment the environment was read. A date the
 * typo rule rejects stays rejected for the life of the process, rather than
 * being re-judged against a clock that keeps moving towards it.
 */
const PROCESS_STARTED_AT = Date.now();

const deferred = [];
let endTimer = null;

/** The current answer, from the process environment and the clock. */
function currentEconomy(now = Date.now()) {
  return resolveEconomy({ env: process.env, now, startedAt: PROCESS_STARTED_AT });
}

/** The sentence a paused pass reports instead of running, or null. */
function economyPauseReasonFor(serviceKey, now = Date.now()) {
  return economyPauseReason(serviceKey, currentEconomy(now));
}

/**
 * A pass interval, slowed while economy mode is on (see ECONOMY_SLOW_INTERVAL_MS)
 * — unless the pass just failed, which retries at its normal pace.
 */
function economyInterval(serviceKey, normalMs, { failed = false, now = Date.now() } = {}) {
  return economyIntervalMs(serviceKey, normalMs, currentEconomy(now), { failed });
}

/**
 * Start a service now, or hold it until economy mode ends.
 *
 * Held only when economy mode is on AND every key the service runs under is a
 * paused one — a service with even one pass that must keep running is started
 * normally and its paused passes are refused by `withRunRecord` instead.
 *
 * @returns {boolean} true when the start was held
 */
function launchUnlessPaused(serviceKeys, launch, { label = serviceKeys.join(', ') } = {}) {
  const state = currentEconomy();
  const held = state.active && serviceKeys.length > 0 && serviceKeys.every(isEconomyPausedKey);
  if (!held) {
    launch();
    return false;
  }
  deferred.push({ label, launch });
  return true;
}

function releaseDeferred() {
  const items = deferred.splice(0);
  let started = 0;
  for (const item of items) {
    try {
      item.launch();
      started += 1;
    } catch (err) {
      console.error(`[ECONOMY] could not start ${item.label}:`, err.message);
    }
  }
  console.log(`[ECONOMY] Economy mode ended — started ${started} of ${items.length} held service(s).`);
}

/**
 * Arm the timer that starts the held services when the date passes. Waits in
 * steps no longer than setTimeout allows, re-reading the clock each time.
 */
function scheduleEconomyEnd(now = Date.now()) {
  if (endTimer || deferred.length === 0) return;
  const state = currentEconomy(now);
  if (!state.active) {
    releaseDeferred();
    return;
  }
  const wait = Math.min(Math.max(state.untilMs - now, 1000), MAX_TIMER_MS);
  endTimer = setTimeout(() => {
    endTimer = null;
    scheduleEconomyEnd();
  }, wait);
  endTimer.unref?.();
}

/** Shutdown: nothing held may start in a process that is going away. */
function cancelEconomyEnd() {
  if (endTimer) { clearTimeout(endTimer); endTimer = null; }
  deferred.length = 0;
}

/**
 * One ledger line per paused key, once at boot, so the admin shows "paused
 * until …" rather than a service that silently stopped reporting. `blocked` is
 * the ledger's word for "not running by configuration", never a failure.
 */
async function notePausedServices(deps = {}) {
  const state = currentEconomy();
  if (!state.active) return 0;
  /* eslint-disable global-require */
  const runs = deps.runs || require('../../database/backgroundRuns');
  const { getServiceEntry } = deps.catalog || require('../../lib/operations/backgroundServiceCatalog');
  /* eslint-enable global-require */
  let noted = 0;
  for (const key of ECONOMY_PAUSED_KEYS) {
    const reason = economyPauseReason(key, state);
    const ok = await runs.recordRunFinish(key, {
      status: 'blocked',
      error: reason,
      summary: { blocked: reason },
      expectedIntervalSeconds: getServiceEntry(key)?.expectedIntervalSeconds ?? null,
    });
    if (ok) noted += 1;
  }
  return noted;
}

/** One boot line saying which way the switch is set, and why. */
function describeEconomyAtBoot() {
  const state = currentEconomy();
  if (state.active) {
    return `[ECONOMY] ON until ${state.until} — ${ECONOMY_PAUSED_KEYS.length} background pass(es) paused `
      + 'to save database traffic; the Dispatcher Board is read every 4 hours.';
  }
  if (state.problem) return `[ECONOMY] OFF — ${state.problem}.`;
  return null;
}

/** Tests only: how many starts are being held. */
function heldCount() {
  return deferred.length;
}

module.exports = {
  currentEconomy,
  economyPauseReasonFor,
  economyInterval,
  launchUnlessPaused,
  scheduleEconomyEnd,
  cancelEconomyEnd,
  notePausedServices,
  describeEconomyAtBoot,
  heldCount,
};
