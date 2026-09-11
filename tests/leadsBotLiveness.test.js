'use strict';

/**
 * The leads bot is a child process, and until this probe existed the run ledger
 * only ever heard that it had STARTED. Production read `stale_stopped` — "no
 * pass has finished in 269 minutes" — about a process that was up the whole
 * time, because a lifecycle event is not a heartbeat.
 *
 * These tests pin the two halves of the fix: the probe answers honestly (a
 * child that does not respond is an error, not silence), and `index.js`
 * actually calls it — the module that is written and never wired is the failure
 * this repository has now made three times.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
  probeOnce,
  startLeadsBotLiveness,
  stopLeadsBotLiveness,
  PROBE_INTERVAL_MS,
  FIRST_PROBE_DELAY_MS,
} = require('../services/leadsBotLiveness');

test('a 200 from the child is a healthy pass', async () => {
  const summary = await probeOnce({ port: 8000, fetchImpl: async () => ({ ok: true, status: 200 }) });
  assert.equal(summary.ok, true);
  assert.equal(summary.error, undefined);
});

test('the probe asks the child on loopback, not a public address', async () => {
  let asked = null;
  await probeOnce({ port: 8123, fetchImpl: async (url) => { asked = url; return { ok: true, status: 200 }; } });
  assert.equal(asked, 'http://127.0.0.1:8123/health');
});

test('a non-200 answer is an error naming the status', async () => {
  const summary = await probeOnce({ port: 8000, fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(summary.ok, undefined);
  assert.match(summary.error, /503/);
});

test('a refused connection is an error naming the code, never the URL', async () => {
  const summary = await probeOnce({
    port: 8000,
    fetchImpl: async () => {
      const err = new Error('fetch failed');
      err.cause = { code: 'ECONNREFUSED' };
      throw err;
    },
  });
  assert.match(summary.error, /ECONNREFUSED/);
  // `/api/health` is public. The reason published there must not carry a URL.
  assert.ok(!summary.error.includes('http'), summary.error);
  assert.ok(!summary.error.includes('127.0.0.1'), summary.error);
});

test('a timeout is named as a timeout rather than an anonymous failure', async () => {
  const summary = await probeOnce({
    port: 8000,
    fetchImpl: async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    },
  });
  assert.match(summary.error, /timeout/);
});

test('the probe never throws, whatever the child does', async () => {
  const summary = await probeOnce({ port: 8000, fetchImpl: async () => { throw new Error('boom'); } });
  assert.ok(summary.error, 'an unexpected failure is still a summary');
});

test('the first probe waits for the child to bind its port, then repeats', async (t) => {
  // The probe is async, so its `finally` that clears the single-flight guard
  // runs on a microtask. Drain between ticks, as a real event loop would.
  const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => stopLeadsBotLiveness());

  let calls = 0;
  startLeadsBotLiveness({
    port: 8000,
    record: (_key, pass) => pass(),
    fetchImpl: () => { calls += 1; return Promise.resolve({ ok: true, status: 200 }); },
  });

  t.mock.timers.tick(FIRST_PROBE_DELAY_MS - 1000);
  assert.equal(calls, 0, 'a probe before the child is listening would be a false failure');

  t.mock.timers.tick(1000);
  await settle();
  assert.equal(calls, 1);

  t.mock.timers.tick(PROBE_INTERVAL_MS);
  await settle();
  assert.equal(calls, 2);
});

test('a hanging probe is not stacked on by the next one', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => stopLeadsBotLiveness());

  let calls = 0;
  startLeadsBotLiveness({
    port: 8000,
    record: (_key, pass) => pass(),
    // Never resolves: the child is up but wedged, which is exactly when a
    // second probe would open a run record the first one closes.
    fetchImpl: () => { calls += 1; return new Promise(() => {}); },
  });

  t.mock.timers.tick(FIRST_PROBE_DELAY_MS);
  t.mock.timers.tick(PROBE_INTERVAL_MS * 3);
  assert.equal(calls, 1);
});

test('stopping ends the probe', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let calls = 0;
  startLeadsBotLiveness({
    port: 8000,
    record: (_key, pass) => pass(),
    fetchImpl: () => { calls += 1; return Promise.resolve({ ok: true, status: 200 }); },
  });
  stopLeadsBotLiveness();
  t.mock.timers.tick(FIRST_PROBE_DELAY_MS + PROBE_INTERVAL_MS * 2);
  assert.equal(calls, 0);
});

test('a port that is not a port starts nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => stopLeadsBotLiveness());
  let calls = 0;
  startLeadsBotLiveness({
    port: Number.NaN,
    record: (_key, pass) => pass(),
    fetchImpl: () => { calls += 1; return Promise.resolve({ ok: true }); },
  });
  t.mock.timers.tick(FIRST_PROBE_DELAY_MS + PROBE_INTERVAL_MS);
  assert.equal(calls, 0);
});

test('index.js starts the probe with the child and stops it when the child goes', () => {
  const INDEX = fs.readFileSync(require.resolve('../index.js'), 'utf8');
  assert.match(INDEX, /startLeadsBotLiveness\(\{ port: leadsPort \}\)/);
  // Both ends of the child's life, and the shutdown path.
  const stops = [...INDEX.matchAll(/stopLeadsBotLiveness\(\)/g)];
  assert.ok(stops.length >= 3, `expected a stop on error, on exit and on shutdown; found ${stops.length}`);
});

test('the probe observes and never restarts the child', () => {
  const SOURCE = fs.readFileSync(require.resolve('../services/leadsBotLiveness'), 'utf8');
  // It watches a process it must never touch: a probe that restarted a healthy
  // but slow child would be a worse outage than the stale row it replaced.
  for (const forbidden of [/child_process/, /\bspawn\(/, /\.kill\(/, /startLeadsBot\(/]) {
    assert.ok(!forbidden.test(SOURCE), `the liveness probe must not use ${forbidden}`);
  }
});
