/**
 * Wake-up scheduling for durable job queues.
 *
 * Shared by the Facebook webhook queue and the trailer notification queue —
 * both store rows with a due timestamp, claim them atomically, and back off on
 * failure. Both used to be discovered by a fixed short poll (5s and 15s), which
 * cost tens of thousands of idle PostgreSQL round-trips a day to notice work
 * that the producer already knew about.
 *
 * The replacement keeps delivery instant and makes the timers rare:
 *
 *   1. EVENT WAKE — the producer pokes the worker the moment it inserts a row,
 *      so a lead or a payment receipt is delivered on the same tick. This is the
 *      path that carries essentially all real traffic.
 *   2. RETRY WAKE — a failed job carries an exact next-due timestamp. Instead of
 *      re-asking PostgreSQL every few seconds whether that moment has arrived,
 *      the worker asks ONCE after each drain and arms a single `setTimeout` for
 *      precisely that timestamp. Retries therefore fire *more* punctually than a
 *      coarse poll managed, for one query per drain instead of thousands a day.
 *   3. IDLE SWEEP — a slow backstop for anything the event path could not have
 *      known about: a row written by another process, a wake-up lost to a
 *      suspended timer, a crash between insert and drain. Startup recovery
 *      covers the crash case directly; the sweep is the belt to that braces.
 *
 * The scheduler owns timers only. It never touches the database or Telegram —
 * the caller supplies `getNextDueAt` and `onWake`, which keeps this module pure
 * enough to test without either.
 */
'use strict';

/** Idle backstop cadence. Was a blanket 5s/15s poll; the wakes replaced it. */
const DEFAULT_SWEEP_MS = 15 * 60 * 1000;
/** Never sweep faster than this, however the env is set. */
const MIN_SWEEP_MS = 60 * 1000;
/**
 * Floor for an armed retry. A retry that came due while the drain was finishing
 * is re-drained promptly, but never in a tight loop.
 */
const DEFAULT_FLOOR_MS = 1_000;

/**
 * Resolve the idle sweep cadence from an env-style value, clamped to
 * MIN_SWEEP_MS. A missing or unparseable value keeps the default.
 */
function resolveSweepMs(raw, fallback = DEFAULT_SWEEP_MS) {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(MIN_SWEEP_MS, parsed);
}

/**
 * @param {object} options
 * @param {(reason: 'sweep'|'retry') => void} options.onWake  Trigger a drain.
 * @param {() => Promise<Date|string|null>} options.getNextDueAt  Earliest
 *   `next_retry_at` still awaiting work, or null when the queue is quiet.
 * @param {number} [options.sweepMs]  Idle backstop cadence.
 * @param {number} [options.floorMs]  Minimum armed-retry delay.
 * @param {() => number} [options.now]  Clock seam for tests.
 * @param {object} [options.logger]
 */
function createQueueWakeScheduler({
  onWake,
  getNextDueAt,
  sweepMs = DEFAULT_SWEEP_MS,
  floorMs = DEFAULT_FLOOR_MS,
  now = Date.now,
  logger = console,
} = {}) {
  if (typeof onWake !== 'function') {
    throw new Error('createQueueWakeScheduler requires an onWake callback');
  }
  if (typeof getNextDueAt !== 'function') {
    throw new Error('createQueueWakeScheduler requires a getNextDueAt callback');
  }

  let sweepTimer = null;
  let retryTimer = null;
  let retryFireAtMs = null;
  let running = false;

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    retryFireAtMs = null;
  }

  /**
   * Arm a single timer for `dueAtMs`. Returns true when a timer was (re)armed.
   *
   * Declines in three cases, each on purpose: the scheduler is stopped; the
   * moment is further out than the idle sweep, which already covers it; or a
   * pending wake would already fire no later than this one.
   */
  function armRetry(dueAtMs) {
    if (!running || !Number.isFinite(dueAtMs)) return false;

    const delay = Math.max(floorMs, dueAtMs - now());
    if (delay >= sweepMs) return false;

    const fireAt = now() + delay;
    if (retryTimer && retryFireAtMs !== null && retryFireAtMs <= fireAt) return false;

    clearRetry();
    retryFireAtMs = fireAt;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryFireAtMs = null;
      onWake('retry');
    }, delay);
    retryTimer.unref?.();
    return true;
  }

  return {
    /** Begin the idle backstop. Idempotent. */
    start() {
      if (running) return;
      running = true;
      sweepTimer = setInterval(() => onWake('sweep'), sweepMs);
      sweepTimer.unref?.();
    },

    /** Stop every timer. Idempotent, and safe to call before start(). */
    stop() {
      running = false;
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      clearRetry();
    },

    isRunning() {
      return running;
    },

    /**
     * Called once a drain has emptied everything currently due. Consults the
     * queue for the next `next_retry_at` and arms a precise wake-up for it.
     *
     * A lookup failure is logged and swallowed: the idle sweep is the fallback,
     * so a transient database error can never strand the queue.
     */
    async afterDrain() {
      if (!running) return false;
      let dueAt;
      try {
        dueAt = await getNextDueAt();
      } catch (err) {
        logger.error?.('[WebhookWorker] Next-retry lookup failed:', err.message);
        return false;
      }
      if (dueAt === null || dueAt === undefined) {
        clearRetry();
        return false;
      }
      const dueAtMs = dueAt instanceof Date ? dueAt.getTime() : new Date(dueAt).getTime();
      return armRetry(dueAtMs);
    },

    /** Milliseconds until the armed retry wake, or null when none is pending. */
    pendingRetryDelayMs() {
      return retryFireAtMs === null ? null : retryFireAtMs - now();
    },
  };
}

module.exports = {
  createQueueWakeScheduler,
  resolveSweepMs,
  DEFAULT_SWEEP_MS,
  MIN_SWEEP_MS,
  DEFAULT_FLOOR_MS,
};
