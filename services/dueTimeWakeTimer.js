/**
 * Self-rescheduling timer for a job whose next due moment is already known.
 *
 * The weekly payroll-adjacent jobs (driver raise rounds, mileage bonus) each
 * fire ONCE A WEEK but were discovered by a 60-second poll — about 1,440
 * PostgreSQL round-trips a day, per service, to notice one event. Both already
 * know exactly when they are next due: the raise round stores `next_run_at`,
 * and the mileage run is a fixed weekday/hour.
 *
 * So sleep until that moment instead. Two properties matter as much as the
 * saving:
 *
 *   - PUNCTUAL. The wake lands ON the due time rather than up to a tick after
 *     it, so the change makes these sends more precise, not less.
 *   - CAPPED. No sleep exceeds `maxSleepMs`, which bounds timer drift and keeps
 *     a config change picked up without a restart. `rearm()` additionally lets
 *     a producer re-plan the moment the due time is rewritten, so an admin
 *     editing the schedule takes effect immediately rather than on the cap.
 *
 * A tick that reports `retry` — or throws — comes back on the short retry
 * cadence instead, because that means a send failed and released its run claim.
 */
'use strict';

const MINUTE_MS = 60 * 1000;

const DEFAULT_MAX_SLEEP_MS = 60 * MINUTE_MS;
/** Never schedule a zero/negative delay — a timer firing early must not spin. */
const DEFAULT_MIN_SLEEP_MS = 1_000;
const DEFAULT_RETRY_MS = MINUTE_MS;

/**
 * @param {object} options
 * @param {() => Promise<{retry?: boolean, dueAtMs?: number|null}|void>} options.runTick
 * @param {string} options.label  Log prefix, e.g. 'RAISE'.
 */
function createDueTimeWakeTimer({
  runTick,
  label,
  maxSleepMs = DEFAULT_MAX_SLEEP_MS,
  minSleepMs = DEFAULT_MIN_SLEEP_MS,
  retryMs = DEFAULT_RETRY_MS,
  now = Date.now,
  logger = console,
} = {}) {
  if (typeof runTick !== 'function') {
    throw new Error('createDueTimeWakeTimer requires a runTick callback');
  }

  let timer = null;
  let stopped = true;

  /** Delay until `dueAtMs`, floored against spin and capped against drift. */
  function sleepMsUntil(dueAtMs) {
    if (!Number.isFinite(dueAtMs)) return maxSleepMs;
    return Math.max(minSleepMs, Math.min(dueAtMs - now(), maxSleepMs));
  }

  function arm(delayMs) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(runAndReschedule, delayMs);
    timer.unref?.();
  }

  async function runAndReschedule() {
    timer = null;
    if (stopped) return;

    let outcome;
    try {
      outcome = await runTick();
    } catch (err) {
      logger.error?.(`[${label}] Scheduler tick error:`, err.message);
      outcome = { retry: true };
    }

    if (stopped) return;
    // A tick may already have re-armed through rearm(); the authoritative delay
    // for the outcome just observed replaces it here.
    arm(outcome && outcome.retry ? retryMs : sleepMsUntil(outcome && outcome.dueAtMs));
  }

  return {
    /** Begin the chain, optionally deferring the first pass past boot. */
    start(initialDelayMs = 0) {
      if (!stopped) return;
      stopped = false;
      arm(Math.max(0, initialDelayMs));
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    /** Re-plan against a due time that just changed. Ignored when stopped. */
    rearm(dueAtMs) {
      if (stopped) return;
      arm(sleepMsUntil(dueAtMs));
    },
    isRunning() {
      return !stopped;
    },
  };
}

module.exports = {
  createDueTimeWakeTimer,
  DEFAULT_MAX_SLEEP_MS,
  DEFAULT_MIN_SLEEP_MS,
  DEFAULT_RETRY_MS,
};
