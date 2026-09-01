/**
 * Wake-up planning for once-a-day jobs.
 *
 * The birthday services used to tick every 60 seconds all day so that a job
 * which fires at ONE fixed hour would not miss it. That cost thousands of
 * idle PostgreSQL round-trips a day to send at most one message.
 *
 * This computes the delay to a job's next meaningful moment instead, so the
 * service can sleep through the hours where it provably has nothing to do. Two
 * deliberate properties:
 *
 *   - PUNCTUAL. The wake lands ON the scheduled time rather than up to a tick
 *     late, so the change makes delivery more precise, not less.
 *   - CAPPED. A sleep is never longer than `maxSleepMs` (one hour by default),
 *     which bounds timer drift and still lets a row added to the database after
 *     the day's send — a birthday entered at noon — be picked up the same day.
 *     A pre-schedule wake is nearly free: those services return before querying.
 *
 * Pure functions over an injected luxon `DateTime`, so the cadence is testable
 * without timers, a clock, or a database.
 */
'use strict';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Re-check cadence once the day's send time has passed. */
const DEFAULT_MAX_SLEEP_MS = HOUR_MS;
/** Never schedule a zero/negative delay — a timer firing early must not spin. */
const DEFAULT_MIN_SLEEP_MS = 1_000;
/** A failed send retries on the old fast cadence; delivery still matters most. */
const DEFAULT_RETRY_MS = MINUTE_MS;

/**
 * Delay in milliseconds until the job should next wake.
 *
 * @param {import('luxon').DateTime} now  Current time in the job's own zone.
 * @param {(isoDate: string) => import('luxon').DateTime} scheduledFor
 *   The job's send moment on a given ISO date.
 * @param {object} [options]
 * @param {number} [options.maxSleepMs]
 * @param {number} [options.minSleepMs]
 */
function nextDailyWakeMs(now, scheduledFor, options = {}) {
  const maxSleepMs = options.maxSleepMs ?? DEFAULT_MAX_SLEEP_MS;
  const minSleepMs = options.minSleepMs ?? DEFAULT_MIN_SLEEP_MS;

  let target = scheduledFor(now.toISODate());
  if (now >= target) {
    // Today's send time has passed; the next one is tomorrow's. The cap below
    // still brings us back within the hour to catch late-added rows.
    target = scheduledFor(now.plus({ days: 1 }).toISODate());
  }

  const delta = target.toMillis() - now.toMillis();
  return Math.max(minSleepMs, Math.min(delta, maxSleepMs));
}

/**
 * Self-rescheduling timer for a once-a-day job.
 *
 * `runTick` is awaited and must resolve to `{ retry: boolean }` (or throw) —
 * `retry` true, or a throw, re-arms on the fast retry cadence so a failed send
 * is not deferred for an hour.
 *
 * @param {object} options
 * @param {() => Promise<{retry?: boolean}|void>} options.runTick
 * @param {() => import('luxon').DateTime} options.now  Clock in the job's zone.
 * @param {(isoDate: string) => import('luxon').DateTime} options.scheduledFor
 * @param {string} options.label  Log prefix, e.g. 'BIRTHDAY'.
 */
function createDailyWakeTimer({
  runTick,
  now,
  scheduledFor,
  label,
  maxSleepMs = DEFAULT_MAX_SLEEP_MS,
  minSleepMs = DEFAULT_MIN_SLEEP_MS,
  retryMs = DEFAULT_RETRY_MS,
  logger = console,
}) {
  let timer = null;
  let stopped = true;

  function arm(delayMs) {
    if (stopped) return;
    timer = setTimeout(runAndReschedule, delayMs);
    timer.unref?.();
  }

  async function runAndReschedule() {
    timer = null;
    if (stopped) return;

    let retry = false;
    try {
      const result = await runTick();
      retry = Boolean(result && result.retry);
    } catch (err) {
      // A throw means the send failed and the run claim was released, so the
      // job must come back promptly rather than waiting out the long sleep.
      logger.error?.(`[${label}] Tick error:`, err.message);
      retry = true;
    }

    if (stopped) return;
    arm(retry ? retryMs : nextDailyWakeMs(now(), scheduledFor, { maxSleepMs, minSleepMs }));
  }

  return {
    /** Run once immediately, then sleep until the next meaningful moment. */
    start() {
      if (!stopped) return;
      stopped = false;
      void runAndReschedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    isRunning() {
      return !stopped;
    },
  };
}

module.exports = {
  nextDailyWakeMs,
  createDailyWakeTimer,
  DEFAULT_MAX_SLEEP_MS,
  DEFAULT_MIN_SLEEP_MS,
  DEFAULT_RETRY_MS,
};
