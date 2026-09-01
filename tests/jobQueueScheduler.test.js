/**
 * Wake-up scheduling for the Facebook webhook queue.
 *
 * These are the bandwidth guards: the worker must sleep until a retry is
 * genuinely due instead of asking PostgreSQL on a fixed tick, and it must never
 * spin. The scheduler owns timers only, so all of it is testable with an
 * injected clock and no database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createQueueWakeScheduler,
  resolveSweepMs,
  DEFAULT_SWEEP_MS,
  MIN_SWEEP_MS,
} = require('../services/jobQueueScheduler');

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const quietLogger = { error: () => {} };

test('resolveSweepMs keeps the default for missing or junk values', () => {
  assert.equal(resolveSweepMs(undefined), DEFAULT_SWEEP_MS);
  assert.equal(resolveSweepMs(''), DEFAULT_SWEEP_MS);
  assert.equal(resolveSweepMs('not-a-number'), DEFAULT_SWEEP_MS);
  assert.equal(resolveSweepMs('0'), DEFAULT_SWEEP_MS);
  assert.equal(resolveSweepMs('-5000'), DEFAULT_SWEEP_MS);
});

test('resolveSweepMs clamps an over-eager sweep up to the one-minute floor', () => {
  // The point of the change is FEWER idle queries; env must not undo that.
  assert.equal(resolveSweepMs('1000'), MIN_SWEEP_MS);
  assert.equal(resolveSweepMs('5000'), MIN_SWEEP_MS);
  assert.equal(resolveSweepMs(String(10 * 60 * 1000)), 10 * 60 * 1000);
});

test('the default idle sweep is far slower than the 5s poll it replaced', () => {
  assert.ok(DEFAULT_SWEEP_MS >= 10 * 60 * 1000, 'idle sweep should be minutes, not seconds');
});

test('afterDrain arms a wake for exactly the next retry timestamp', async () => {
  const clock = makeClock();
  const dueAt = new Date(clock.now() + 90_000);
  const scheduler = createQueueWakeScheduler({
    onWake: () => {},
    getNextDueAt: async () => dueAt,
    now: clock.now,
  });
  scheduler.start();

  assert.equal(await scheduler.afterDrain(), true);
  assert.equal(scheduler.pendingRetryDelayMs(), 90_000, 'sleeps until the retry is due, not a fixed tick');

  scheduler.stop();
});

test('a retry actually fires when its moment arrives', async () => {
  const wakes = [];
  const scheduler = createQueueWakeScheduler({
    onWake: (reason) => wakes.push(reason),
    getNextDueAt: async () => new Date(Date.now() + 5),
    floorMs: 1,
  });
  scheduler.start();

  await scheduler.afterDrain();
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.deepEqual(wakes, ['retry'], 'the armed wake drains the queue');
  scheduler.stop();
});

test('a retry further out than the sweep is left to the sweep', async () => {
  const clock = makeClock();
  const scheduler = createQueueWakeScheduler({
    onWake: () => {},
    getNextDueAt: async () => new Date(clock.now() + 60 * 60 * 1000),
    sweepMs: 15 * 60 * 1000,
    now: clock.now,
  });
  scheduler.start();

  assert.equal(await scheduler.afterDrain(), false);
  assert.equal(scheduler.pendingRetryDelayMs(), null, 'no redundant timer alongside the sweep');

  scheduler.stop();
});

test('an empty queue clears any armed wake', async () => {
  const clock = makeClock();
  let dueAt = new Date(clock.now() + 30_000);
  const scheduler = createQueueWakeScheduler({
    onWake: () => {},
    getNextDueAt: async () => dueAt,
    now: clock.now,
  });
  scheduler.start();

  await scheduler.afterDrain();
  assert.equal(scheduler.pendingRetryDelayMs(), 30_000);

  dueAt = null; // the retry succeeded; nothing is waiting any more
  assert.equal(await scheduler.afterDrain(), false);
  assert.equal(scheduler.pendingRetryDelayMs(), null, 'a quiet queue holds no timers at all');

  scheduler.stop();
});

test('an earlier armed wake is never pushed back by a later one', async () => {
  const clock = makeClock();
  let dueAt = new Date(clock.now() + 20_000);
  const scheduler = createQueueWakeScheduler({
    onWake: () => {},
    getNextDueAt: async () => dueAt,
    now: clock.now,
  });
  scheduler.start();

  await scheduler.afterDrain();
  assert.equal(scheduler.pendingRetryDelayMs(), 20_000);

  dueAt = new Date(clock.now() + 120_000);
  assert.equal(await scheduler.afterDrain(), false, 'declines to delay work already scheduled');
  assert.equal(scheduler.pendingRetryDelayMs(), 20_000);

  scheduler.stop();
});

test('an overdue timestamp is floored, so a stuck row cannot spin the loop', async () => {
  const clock = makeClock();
  const scheduler = createQueueWakeScheduler({
    onWake: () => {},
    // Already 10 minutes late — the naive delay would be negative.
    getNextDueAt: async () => new Date(clock.now() - 600_000),
    floorMs: 1_000,
    now: clock.now,
  });
  scheduler.start();

  assert.equal(await scheduler.afterDrain(), true);
  assert.equal(scheduler.pendingRetryDelayMs(), 1_000, 'floored, never zero or negative');

  scheduler.stop();
});

test('a failed lookup is swallowed — the sweep remains the fallback', async () => {
  const scheduler = createQueueWakeScheduler({
    onWake: () => {},
    getNextDueAt: async () => { throw new Error('database unreachable'); },
    logger: quietLogger,
  });
  scheduler.start();

  assert.equal(await scheduler.afterDrain(), false, 'no throw escapes into the drain');
  assert.equal(scheduler.pendingRetryDelayMs(), null);
  assert.equal(scheduler.isRunning(), true, 'the worker stays up');

  scheduler.stop();
});

test('a stopped scheduler arms nothing and start/stop are idempotent', async () => {
  const scheduler = createQueueWakeScheduler({
    onWake: () => {},
    getNextDueAt: async () => new Date(Date.now() + 1000),
  });

  assert.equal(await scheduler.afterDrain(), false, 'nothing scheduled before start()');

  scheduler.start();
  scheduler.start();
  assert.equal(scheduler.isRunning(), true);

  await scheduler.afterDrain();
  scheduler.stop();
  scheduler.stop();

  assert.equal(scheduler.isRunning(), false);
  assert.equal(scheduler.pendingRetryDelayMs(), null, 'shutdown leaves no timer behind');
});

test('the scheduler refuses to be built without its callbacks', () => {
  assert.throws(() => createQueueWakeScheduler({ getNextDueAt: async () => null }), /onWake/);
  assert.throws(() => createQueueWakeScheduler({ onWake: () => {} }), /getNextDueAt/);
});
