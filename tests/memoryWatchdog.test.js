/**
 * Tests for services/memoryWatchdog.js — the opt-in RSS/heap logger for the
 * memory-constrained Render instance. Pure logic tests: no timers left running,
 * no real thresholds crossed.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://user:pass@localhost:5432/testdb';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-0123456789abcdef';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '111111:TEST_TOKEN_A';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '222222:TEST_TOKEN_B';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY = process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY
  || '0123456789abcdef0123456789abcdef';

const test = require('node:test');
const assert = require('node:assert');

const watchdog = require('../services/memoryWatchdog');

const MB = 1024 * 1024;
function fakeMemory({ rssMb = 100, heapUsedMb = 50 } = {}) {
  return {
    rss: rssMb * MB,
    heapUsed: heapUsedMb * MB,
    heapTotal: (heapUsedMb + 20) * MB,
    external: 5 * MB,
  };
}

test('disabled by default: start is a no-op returning false', () => {
  delete process.env.MEMORY_WATCHDOG_ENABLED;
  assert.strictEqual(watchdog.isEnabled(), false);
  assert.strictEqual(watchdog.startMemoryWatchdog(), false);
  watchdog.stopMemoryWatchdog();
});

test('settings: defaults and env overrides, interval clamped to >= 60s', () => {
  delete process.env.MEMORY_WATCHDOG_INTERVAL_MS;
  delete process.env.MEMORY_WATCHDOG_RSS_WARN_MB;
  delete process.env.MEMORY_WATCHDOG_HEAP_WARN_MB;
  let s = watchdog.settings();
  assert.strictEqual(s.intervalMs, 15 * 60 * 1000);
  assert.strictEqual(s.rssWarnMb, 450);
  assert.strictEqual(s.heapWarnMb, 200);

  process.env.MEMORY_WATCHDOG_INTERVAL_MS = '1000'; // below the 60s floor
  process.env.MEMORY_WATCHDOG_RSS_WARN_MB = '300';
  process.env.MEMORY_WATCHDOG_HEAP_WARN_MB = '150';
  s = watchdog.settings();
  assert.strictEqual(s.intervalMs, 60 * 1000);
  assert.strictEqual(s.rssWarnMb, 300);
  assert.strictEqual(s.heapWarnMb, 150);

  delete process.env.MEMORY_WATCHDOG_INTERVAL_MS;
  delete process.env.MEMORY_WATCHDOG_RSS_WARN_MB;
  delete process.env.MEMORY_WATCHDOG_HEAP_WARN_MB;
});

test('sample below thresholds logs without warning', () => {
  watchdog.stopMemoryWatchdog(); // reset warn cooldown state
  const cfg = { rssWarnMb: 450, heapWarnMb: 200 };
  const { line, warned } = watchdog.sampleOnce(cfg, Date.now(), fakeMemory({ rssMb: 120, heapUsedMb: 60 }));
  assert.strictEqual(warned, false);
  assert.match(line, /rss=120MB/);
  assert.match(line, /heapUsed=60MB/);
  assert.doesNotMatch(line, /WARNING/);
});

test('RSS over threshold warns once, then respects the hourly cooldown', () => {
  watchdog.stopMemoryWatchdog();
  const cfg = { rssWarnMb: 450, heapWarnMb: 200 };
  const t0 = Date.now();

  const first = watchdog.sampleOnce(cfg, t0, fakeMemory({ rssMb: 470, heapUsedMb: 60 }));
  assert.strictEqual(first.warned, true);
  assert.match(first.line, /WARNING: RSS 470MB >= 450MB/);

  // 5 minutes later, still high — cooldown suppresses the repeat warning.
  const second = watchdog.sampleOnce(cfg, t0 + 5 * 60 * 1000, fakeMemory({ rssMb: 480, heapUsedMb: 60 }));
  assert.strictEqual(second.warned, false);

  // 61 minutes later, still high — warns again.
  const third = watchdog.sampleOnce(cfg, t0 + 61 * 60 * 1000, fakeMemory({ rssMb: 480, heapUsedMb: 60 }));
  assert.strictEqual(third.warned, true);
});

test('recovery resets the cooldown so the next crossing warns immediately', () => {
  watchdog.stopMemoryWatchdog();
  const cfg = { rssWarnMb: 450, heapWarnMb: 200 };
  const t0 = Date.now();

  assert.strictEqual(watchdog.sampleOnce(cfg, t0, fakeMemory({ rssMb: 470 })).warned, true);
  // Memory recovered.
  assert.strictEqual(watchdog.sampleOnce(cfg, t0 + 60_000, fakeMemory({ rssMb: 200 })).warned, false);
  // Crosses again 2 minutes later — warns right away despite the earlier warn.
  assert.strictEqual(watchdog.sampleOnce(cfg, t0 + 120_000, fakeMemory({ rssMb: 470 })).warned, true);
});

test('heapUsed over threshold warns with a heap reason', () => {
  watchdog.stopMemoryWatchdog();
  const cfg = { rssWarnMb: 450, heapWarnMb: 200 };
  const { line, warned } = watchdog.sampleOnce(cfg, Date.now(), fakeMemory({ rssMb: 300, heapUsedMb: 210 }));
  assert.strictEqual(warned, true);
  assert.match(line, /heapUsed 210MB >= 200MB/);
});

test('start when enabled, idempotent double-start, stop clears the timer', () => {
  process.env.MEMORY_WATCHDOG_ENABLED = 'true';
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    assert.strictEqual(watchdog.startMemoryWatchdog(), true);
    assert.strictEqual(watchdog.startMemoryWatchdog(), true); // no double timer
  } finally {
    console.log = origLog;
    watchdog.stopMemoryWatchdog();
    delete process.env.MEMORY_WATCHDOG_ENABLED;
  }
  assert.ok(logs.some((l) => l.includes('[MEMORY] Watchdog enabled')));
  assert.ok(logs.some((l) => /\[MEMORY\] rss=\d+MB/.test(l)), 'boot baseline sample logged');
});
