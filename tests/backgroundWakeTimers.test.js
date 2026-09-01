/**
 * Wake planning for the once-a-day and once-a-week background jobs.
 *
 * These services used to tick every 60 seconds so a job firing at ONE moment
 * would not be missed — thousands of idle PostgreSQL round-trips a day each.
 * The replacement sleeps until the job is actually due, so what these tests pin
 * is that the saving never costs punctuality or a retry:
 *
 *   - the wake lands ON the scheduled moment, not a tick after it;
 *   - a failed send still comes back on the fast cadence;
 *   - sleeps are capped, so a config change is picked up without a restart;
 *   - no path can produce a zero/negative delay and spin.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

const {
  nextDailyWakeMs,
  DEFAULT_MAX_SLEEP_MS,
} = require('../services/dailyWakeSchedule');
const { createDueTimeWakeTimer } = require('../services/dueTimeWakeTimer');

const TZ = 'America/Chicago';
/** The driver birthday schedule: 08:00 Central. */
const at8am = (isoDate) => DateTime.fromISO(isoDate, { zone: TZ }).set({
  hour: 8, minute: 0, second: 0, millisecond: 0,
});

// ── daily wake planning ──

test('before the send hour, the wake lands exactly on it', () => {
  const now = DateTime.fromISO('2026-06-12T07:30:00', { zone: TZ });
  assert.equal(nextDailyWakeMs(now, at8am), 30 * 60 * 1000);
});

test('a send hour further out than the cap is approached in capped steps', () => {
  const now = DateTime.fromISO('2026-06-12T02:00:00', { zone: TZ });
  // Six hours away: sleep the cap, wake, re-plan — drift stays bounded and the
  // pre-schedule wake costs no query because the service returns before its DB call.
  assert.equal(nextDailyWakeMs(now, at8am), DEFAULT_MAX_SLEEP_MS);
});

test('after the send hour it re-checks within the cap, not once a day', () => {
  const now = DateTime.fromISO('2026-06-12T09:00:00', { zone: TZ });
  // Tomorrow's 08:00 is 23h away, but the cap brings it back within the hour so
  // a birthday row added after the morning send is still picked up today.
  assert.equal(nextDailyWakeMs(now, at8am), DEFAULT_MAX_SLEEP_MS);
});

test('a timer that fires a hair early re-arms instead of spinning', () => {
  const now = DateTime.fromISO('2026-06-12T07:59:59.999', { zone: TZ });
  const delay = nextDailyWakeMs(now, at8am, { minSleepMs: 1000 });
  assert.ok(delay >= 1000, `floored to ${delay}ms, never zero or negative`);
});

test('the plan follows a DST shift rather than drifting an hour', () => {
  // US DST begins 2026-03-08. The wake must still land on wall-clock 08:00.
  const now = DateTime.fromISO('2026-03-08T07:30:00', { zone: TZ });
  const target = now.plus({ milliseconds: nextDailyWakeMs(now, at8am, { maxSleepMs: 24 * 3600 * 1000 }) });
  assert.equal(target.hour, 8, 'lands on 08:00 local, whatever the offset did');
});

// ── due-time wake chain (weekly jobs) ──

test('the chain sleeps to a known due time and reports it punctually', async () => {
  const dueAt = Date.now() + 20;
  const runs = [];
  const timer = createDueTimeWakeTimer({
    label: 'TEST',
    runTick: async () => { runs.push(Date.now()); return { retry: false, dueAtMs: dueAt }; },
    minSleepMs: 1,
    maxSleepMs: 5_000,
  });

  timer.start(1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(runs.length >= 2, 'ran, slept to the due time, ran again');

  timer.stop();
});

test('a failed send retries on the fast cadence, not the long sleep', async () => {
  const runs = [];
  const timer = createDueTimeWakeTimer({
    label: 'TEST',
    // Reports failure and a due time a week out; retry must win.
    runTick: async () => { runs.push(1); return { retry: true, dueAtMs: Date.now() + 7 * 86400_000 }; },
    retryMs: 10,
    maxSleepMs: 60_000,
  });

  timer.start(1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(runs.length >= 3, `retried promptly (${runs.length} passes), ignoring the weekly due time`);

  timer.stop();
});

test('a throwing tick is treated as a failure, not a stalled service', async () => {
  const runs = [];
  const errors = [];
  const timer = createDueTimeWakeTimer({
    label: 'TEST',
    runTick: async () => { runs.push(1); throw new Error('telegram unreachable'); },
    retryMs: 10,
    logger: { error: (...args) => errors.push(args) },
  });

  timer.start(1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(runs.length >= 2, 'kept running after the throw');
  assert.ok(errors.length >= 1, 'and logged it');

  timer.stop();
});

test('rearm re-plans immediately when an admin moves the schedule', async () => {
  const runs = [];
  const timer = createDueTimeWakeTimer({
    label: 'TEST',
    runTick: async () => { runs.push(1); return { retry: false, dueAtMs: Date.now() + 3600_000 }; },
    minSleepMs: 1,
    maxSleepMs: 3600_000,
  });

  timer.start(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const afterFirst = runs.length;

  // The admin saved a new time; the service must not wait out the long sleep.
  timer.rearm(Date.now() + 5);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(runs.length > afterFirst, 'the new schedule took effect without a restart');

  timer.stop();
});

test('a missing due time falls back to the cap rather than never waking', async () => {
  const runs = [];
  const timer = createDueTimeWakeTimer({
    label: 'TEST',
    // A disabled service reports no due time at all.
    runTick: async () => { runs.push(1); return { retry: false }; },
    maxSleepMs: 15,
  });

  timer.start(1);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.ok(runs.length >= 2, 're-checks on the cap, so re-enabling is noticed');

  timer.stop();
});

test('stop() halts the chain and start/stop are idempotent', async () => {
  let runs = 0;
  const timer = createDueTimeWakeTimer({
    label: 'TEST',
    runTick: async () => { runs += 1; return { retry: true }; },
    retryMs: 5,
  });

  timer.start(1);
  timer.start(1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  timer.stop();
  timer.stop();

  const runsAtStop = runs;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(runs, runsAtStop, 'shutdown leaves no timer running');
  assert.equal(timer.isRunning(), false);
  timer.rearm(Date.now() + 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runs, runsAtStop, 'rearm after stop stays inert');
});

test('the timer refuses to be built without a tick', () => {
  assert.throws(() => createDueTimeWakeTimer({ label: 'TEST' }), /runTick/);
});
