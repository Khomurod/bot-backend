/**
 * Lightweight, opt-in memory watchdog for the 512 MB Render free instance.
 *
 * When enabled it samples process.memoryUsage() on a fixed interval and:
 *   - logs one compact line per sample (rss / heapUsed / heapTotal / external);
 *   - escalates to console.warn when RSS or heapUsed crosses its threshold;
 *   - while a threshold stays crossed, re-warns at most once per hour so a
 *     sustained high-water mark cannot flood the logs.
 *
 * It allocates nothing beyond a few numbers per tick and the timer is
 * unref()'d, so it never keeps the process alive and never becomes a memory
 * cost itself.
 *
 * Configuration (all optional):
 *   MEMORY_WATCHDOG_ENABLED       'true' to turn on (default: false — off)
 *   MEMORY_WATCHDOG_INTERVAL_MS   sample cadence (default 900000 = 15 min,
 *                                 clamped to >= 60s so it cannot spin)
 *   MEMORY_WATCHDOG_RSS_WARN_MB   RSS warn threshold (default 450)
 *   MEMORY_WATCHDOG_HEAP_WARN_MB  heapUsed warn threshold (default 200 —
 *                                 the heap cap is --max-old-space-size=256)
 */

const MIN_INTERVAL_MS = 60 * 1000;
const REWARN_EVERY_MS = 60 * 60 * 1000; // repeat a sustained warning at most hourly

let timer = null;
let lastWarnAt = 0;

function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isEnabled() {
  return process.env.MEMORY_WATCHDOG_ENABLED === 'true';
}

function settings() {
  return {
    intervalMs: Math.max(MIN_INTERVAL_MS, envInt('MEMORY_WATCHDOG_INTERVAL_MS', 15 * 60 * 1000)),
    rssWarnMb: envInt('MEMORY_WATCHDOG_RSS_WARN_MB', 450),
    heapWarnMb: envInt('MEMORY_WATCHDOG_HEAP_WARN_MB', 200),
  };
}

function toMb(bytes) {
  return Math.round(bytes / (1024 * 1024));
}

/** One sample: returns the log line + whether it warned (exported for tests). */
function sampleOnce({ rssWarnMb, heapWarnMb }, now = Date.now(), memory = process.memoryUsage()) {
  const rssMb = toMb(memory.rss);
  const heapUsedMb = toMb(memory.heapUsed);
  const line = `[MEMORY] rss=${rssMb}MB heapUsed=${heapUsedMb}MB `
    + `heapTotal=${toMb(memory.heapTotal)}MB external=${toMb(memory.external)}MB`;

  const overRss = rssMb >= rssWarnMb;
  const overHeap = heapUsedMb >= heapWarnMb;
  if (overRss || overHeap) {
    const reasons = [
      overRss ? `RSS ${rssMb}MB >= ${rssWarnMb}MB` : null,
      overHeap ? `heapUsed ${heapUsedMb}MB >= ${heapWarnMb}MB` : null,
    ].filter(Boolean).join('; ');
    if (now - lastWarnAt >= REWARN_EVERY_MS) {
      lastWarnAt = now;
      return { line: `${line} — WARNING: ${reasons}. Nearing the 512MB instance limit.`, warned: true };
    }
    // Threshold still crossed but within the re-warn cooldown: plain log line.
    return { line, warned: false };
  }
  lastWarnAt = 0; // recovered — the next crossing warns immediately
  return { line, warned: false };
}

function tick(cfg) {
  try {
    const { line, warned } = sampleOnce(cfg);
    if (warned) console.warn(line);
    else console.log(line);
  } catch (err) {
    console.error('[MEMORY] watchdog sample failed:', err.message);
  }
}

function startMemoryWatchdog() {
  if (!isEnabled()) return false;
  if (timer) return true; // already running — never double-start
  const cfg = settings();
  console.log(`[MEMORY] Watchdog enabled — sampling every ${Math.round(cfg.intervalMs / 60000)}min `
    + `(warn: rss>=${cfg.rssWarnMb}MB, heapUsed>=${cfg.heapWarnMb}MB)`);
  tick(cfg); // immediate baseline sample so boot memory is visible in logs
  timer = setInterval(() => tick(cfg), cfg.intervalMs);
  timer.unref?.();
  return true;
}

function stopMemoryWatchdog() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  lastWarnAt = 0;
}

module.exports = {
  startMemoryWatchdog,
  stopMemoryWatchdog,
  // exported for unit tests
  sampleOnce,
  settings,
  isEnabled,
};
