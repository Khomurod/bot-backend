/**
 * pollCoordinator.js
 * Centralized staggered scheduler for Samsara pollers.
 *
 * Replaces dual independent setInterval loops with a single-threaded,
 * sequential scheduler.  The safety poller fires at the top of each
 * 30-second cycle and the speeding poller fires 15 seconds later.
 *
 * Uses setTimeout chaining (not setInterval) so a slow tick pushes
 * the next one forward rather than piling up overlapping runs.
 */

const poller = require('./poller');
const speedingPoller = require('./speedingPoller');

const CYCLE_MS = 30_000;           // full cycle length
const PHASE_OFFSET_MS = 15_000;    // speeding poller fires 15 s after safety
const ENABLE_METRICS = process.env.SAMSARA_POLL_METRICS !== 'false';
const METRICS_INTERVAL_MS = 60_000;

let running = false;
let cycleTimer = null;
let metricsTimer = null;

/** Run a single poller, swallowing errors so the coordinator keeps ticking. */
async function runSafe(label, fn) {
    const t0 = Date.now();
    try {
        await fn();
    } catch (err) {
        console.error(`[Coordinator] ${label} error:`, err.message);
    }
    const elapsed = Date.now() - t0;
    if (elapsed > PHASE_OFFSET_MS) {
        console.warn(`[Coordinator] ${label} took ${elapsed}ms (>${PHASE_OFFSET_MS}ms phase window)`);
    }
}

/**
 * One full cycle:
 *   1. Run safety poller (waits for completion)
 *   2. Pause for PHASE_OFFSET_MS (or the remainder if the poller took some time)
 *   3. Run speeding poller (waits for completion)
 *   4. Schedule the next cycle
 */
async function cycle() {
    if (!running) return;

    // ── Phase 1: Safety poller ──
    const safetyStart = Date.now();
    await runSafe('SafetyPoller', () => poller.executePoll());
    const safetyElapsed = Date.now() - safetyStart;

    if (!running) return;

    // ── Stagger gap ──
    const gap = Math.max(0, PHASE_OFFSET_MS - safetyElapsed);
    if (gap > 0) {
        await new Promise((resolve) => {
            cycleTimer = setTimeout(resolve, gap);
        });
    }

    if (!running) return;

    // ── Phase 2: Speeding poller ──
    await runSafe('SpeedingPoller', () => speedingPoller.executePoll());

    if (!running) return;

    // ── Schedule next cycle ──
    const totalElapsed = Date.now() - safetyStart;
    const nextDelay = Math.max(1000, CYCLE_MS - totalElapsed);
    cycleTimer = setTimeout(() => cycle(), nextDelay);
}

function logMetrics() {
    const mem = process.memoryUsage();
    console.log(
        `[Coordinator] Metrics rss=${Math.round(mem.rss / 1024 / 1024)}MB` +
        ` heapUsed=${Math.round(mem.heapUsed / 1024 / 1024)}MB` +
        ` heapTotal=${Math.round(mem.heapTotal / 1024 / 1024)}MB` +
        ` external=${Math.round(mem.external / 1024 / 1024)}MB`,
    );
}

module.exports = {
    start() {
        if (running) return;
        running = true;
        console.log(`[Coordinator] Starting staggered poll cycle (${CYCLE_MS / 1000}s cycle, ${PHASE_OFFSET_MS / 1000}s phase offset)`);
        cycle();

        if (ENABLE_METRICS) {
            metricsTimer = setInterval(logMetrics, METRICS_INTERVAL_MS);
        }
    },

    stop() {
        running = false;
        if (cycleTimer) {
            clearTimeout(cycleTimer);
            cycleTimer = null;
        }
        if (metricsTimer) {
            clearInterval(metricsTimer);
            metricsTimer = null;
        }
        console.log('[Coordinator] Stopped.');
    },
};
