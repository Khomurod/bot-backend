'use strict';

/**
 * The two AI passes that run on a SCHEDULE, not on every wake of their timer.
 *
 * Their wake timer never sleeps longer than an hour (createDueTimeWakeTimer's
 * cap), and both used to run their whole pass on every wake. Model maintenance
 * fetched and wrote every provider's listing about 24 times a day instead of
 * once at 06:00 UTC. The terms watcher made its six outbound requests about 24
 * times a day, on every day, instead of at 09:00 UTC on the check days. These
 * pin "run on the first wake after boot, then on the schedule, and retry a run
 * that did not do its job".
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@127.0.0.1:1/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMaintenanceTick } = require('../services/ai/discovery/modelMaintenance');
const { createPolicyCheckTick } = require('../services/ai/policy/policyService');

const HOUR = 60 * 60 * 1000;

function clock(iso) {
  let t = Date.parse(iso);
  return { now: () => t, advance(ms) { t += ms; }, at: () => new Date(t) };
}

test('MODEL MAINTENANCE: once after boot, then at 06:00 UTC — not on every hourly wake', async () => {
  const c = clock('2026-10-21T10:00:00Z');
  let runs = 0;
  const tick = createMaintenanceTick({ run: async () => { runs += 1; return { refreshed: 1 }; }, now: c.now });

  await tick();
  assert.equal(runs, 1, 'the first wake after boot runs');
  for (let h = 0; h < 19; h += 1) { c.advance(HOUR); await tick(); }
  assert.equal(runs, 1, 'nineteen hourly wakes later (05:00 next day) it has not run again');
  c.advance(HOUR); // 06:00 UTC
  const due = await tick();
  assert.equal(runs, 2, 'and 06:00 UTC runs it');
  assert.equal(new Date(due.dueAtMs).toISOString(), '2026-10-23T06:00:00.000Z');
});

test('MODEL MAINTENANCE: a run that failed is tried again at the next wake', async () => {
  const c = clock('2026-10-21T10:00:00Z');
  const outcomes = [new Error('network down'), { error: 'verified nothing' }, { refreshed: 2 }];
  let runs = 0;
  const tick = createMaintenanceTick({
    run: async () => { const o = outcomes[runs]; runs += 1; if (o instanceof Error) throw o; return o; },
    now: c.now,
  });
  await tick(); c.advance(HOUR); await tick(); c.advance(HOUR); await tick();
  assert.equal(runs, 3, 'a throw and an error summary are both retried an hour later');
  c.advance(HOUR); await tick();
  assert.equal(runs, 3, 'a run that did its job is not');
});

function policyDeps(c, { days = 'mon,thu', enabled = true, results = [] } = {}) {
  const calls = { checks: 0, heartbeats: 0 };
  const settings = { enabled, checkDays: days };
  return {
    calls,
    settings,
    tick: createPolicyCheckTick({
      store: { async getWatcherSettings() { return { ...settings }; } },
      runCheck: async () => ({ checked: 6 }),
      recordRun: async (_key, pass) => {
        calls.checks += 1;
        const r = results[calls.checks - 1];
        if (r instanceof Error) throw r;
        return r || pass();
      },
      heartbeat: async () => { calls.heartbeats += 1; },
      now: c.at,
    }),
  };
}

test('TERMS WATCHER: once after boot, then 09:00 UTC on a check day — not every hour, every day', async () => {
  const c = clock('2026-10-21T10:00:00Z'); // a Wednesday
  const { tick, calls } = policyDeps(c);
  await tick();
  assert.equal(calls.checks, 1, 'the first wake after boot checks');
  for (let h = 0; h < 22; h += 1) { c.advance(HOUR); await tick(); } // Thursday 08:00
  assert.equal(calls.checks, 1, 'no check on Wednesday afternoon or before Thursday 09:00');
  c.advance(HOUR); // Thursday 09:00
  await tick();
  assert.equal(calls.checks, 2, 'Thursday 09:00 checks');
  for (let h = 0; h < 24; h += 1) { c.advance(HOUR); await tick(); } // through Friday
  assert.equal(calls.checks, 2, 'Friday is not a check day');
});

test('TERMS WATCHER: new check days are honoured from the last check; a failed check is retried', async () => {
  const c = clock('2026-10-21T10:00:00Z'); // Wednesday
  const { tick, calls, settings } = policyDeps(c, { results: [undefined, new Error('source down')] });
  await tick();
  settings.checkDays = 'wed'; // now only Wednesdays — the next slot is next Wednesday
  c.advance(23 * HOUR); await tick(); // Thursday 09:00
  assert.equal(calls.checks, 1, 'Thursday is no longer a check day');
  c.advance(6 * 24 * HOUR); await tick(); // next Wednesday 09:00
  assert.equal(calls.checks, 2, 'the new day is used, and that check fails');
  c.advance(HOUR); await tick();
  assert.equal(calls.checks, 3, 'so the next wake tries again');
});

test('TERMS WATCHER: switched off, it checks nothing and says so', async () => {
  const c = clock('2026-10-21T10:00:00Z');
  const { tick, calls } = policyDeps(c, { enabled: false });
  await tick(); c.advance(HOUR); await tick();
  assert.deepEqual([calls.checks, calls.heartbeats], [0, 2]);
});

test('MODEL MAINTENANCE: a pass that runs across 06:00 is not run again the moment it ends', async () => {
  const c = clock('2026-10-22T05:59:00Z');
  let runs = 0;
  const tick = createMaintenanceTick({
    run: async () => { runs += 1; c.advance(2 * 60 * 1000); return { refreshed: 1 }; }, // ends 06:01
    now: c.now,
  });
  const due = await tick();
  assert.equal(new Date(due.dueAtMs).toISOString(), '2026-10-23T06:00:00.000Z',
    'the next slot is after the pass ENDED, not after it began');
  c.advance(60 * 1000); await tick();
  assert.equal(runs, 1);
});

test('TERMS WATCHER: a check in which EVERY source failed is retried at the next wake', async () => {
  const c = clock('2026-10-21T10:00:00Z');
  const { tick, calls } = policyDeps(c, { results: [{ sources: 6, errors: 6 }, { sources: 6, errors: 1 }] });
  await tick();
  c.advance(HOUR); await tick();
  assert.equal(calls.checks, 2, 'nothing was read, so it is tried again an hour later');
  c.advance(HOUR); await tick();
  assert.equal(calls.checks, 2, 'one source failing among six is a check that did its job');
});

test('TERMS WATCHER: a check that runs across 09:00 is not run again the moment it ends', async () => {
  const c = clock('2026-10-22T08:59:00Z'); // Thursday, a check day
  const calls = { checks: 0 };
  const tick = createPolicyCheckTick({
    store: { async getWatcherSettings() { return { enabled: true, checkDays: 'mon,thu' }; } },
    runCheck: async () => ({ sources: 6, errors: 0 }),
    recordRun: async (_key, pass) => { calls.checks += 1; c.advance(2 * 60 * 1000); return pass(); },
    heartbeat: async () => {},
    now: c.at,
  });
  await tick();
  c.advance(60 * 1000); await tick();
  assert.equal(calls.checks, 1);
});
