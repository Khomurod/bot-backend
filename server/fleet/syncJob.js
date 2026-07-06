/**
 * FleetView sync job — runs the FleetView snapshot build on an interval so the
 * UI always reads a warm database cache instead of blocking on live APIs.
 *
 * Cadence (decision): default 30s live snapshot refresh, overridable with
 * FLEETVIEW_SYNC_INTERVAL_SECONDS (clamped to a safe 10–600s range). The job:
 *   - runs ONLY in FleetView real mode (no-op in demo/local);
 *   - never overlaps itself (a slow run delays the next tick, it does not stack)
 *     via a setTimeout chain + the sync service's own re-entrancy guard;
 *   - is fail-soft: one bad run is logged and the loop continues serving the
 *     previous cached snapshot.
 *
 * Mirrors the setTimeout-chain pattern used by the main app's message scheduler
 * so a long run can never pile up duplicate ticks. Started from mountFleet() so
 * FleetView owns its own background refresh (isolation invariant: nothing
 * outside server/fleet references it).
 */

'use strict';

const { isReal } = require('./config');

const DEFAULT_INTERVAL_SECONDS = 30;
const MIN_INTERVAL_SECONDS = 10;
const MAX_INTERVAL_SECONDS = 600;

let nextTickTimer = null;
let stopped = true;
let running = false;

function intervalMs() {
  const raw = Number(process.env.FLEETVIEW_SYNC_INTERVAL_SECONDS);
  const secs = Number.isFinite(raw) && raw > 0
    ? Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, raw))
    : DEFAULT_INTERVAL_SECONDS;
  return secs * 1000;
}

async function tick() {
  if (running) return; // re-entrancy guard (belt-and-suspenders with the service)
  running = true;
  const t0 = Date.now();
  try {
    const svc = require('./syncService');
    const res = await svc.runOnce({ force: true, triggeredBy: 'sync-job' });
    if (res && !res.skipped) {
      const errs = (res.errors || []).length;
      console.log(`[FLEETVIEW-SYNC] snapshot built in ${res.durationMs}ms — ${res.totalRecords} records`
        + `${errs ? `, ${errs} dataset error(s)` : ''}`);
    }
  } catch (err) {
    console.error('[FLEETVIEW-SYNC] tick error:', err.message);
  } finally {
    running = false;
  }
}

function scheduleNextTick() {
  if (stopped) return;
  nextTickTimer = setTimeout(async () => {
    await tick();
    scheduleNextTick();
  }, intervalMs());
  nextTickTimer.unref?.();
}

function startFleetviewSyncJob() {
  if (!isReal()) {
    console.log('[FLEETVIEW-SYNC] Not started (FleetView is not in real mode).');
    return;
  }
  if (!stopped) return;
  stopped = false;
  console.log(`[FLEETVIEW-SYNC] Started — refreshing FleetView snapshot every ${intervalMs() / 1000}s`);
  // Fire once on boot to warm the cache, then chain subsequent ticks.
  (async () => {
    await tick();
    scheduleNextTick();
  })();
}

function stopFleetviewSyncJob() {
  stopped = true;
  if (nextTickTimer) { clearTimeout(nextTickTimer); nextTickTimer = null; }
  console.log('[FLEETVIEW-SYNC] Stopped.');
}

module.exports = { startFleetviewSyncJob, stopFleetviewSyncJob, tick };
