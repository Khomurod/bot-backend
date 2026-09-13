/**
 * Seven states, and why collapsing any pair loses a decision.
 *
 * The state this file exists for is `stale_stopped`. A worker that failed is
 * loud; a worker that STOPPED is silent, and every table it owns looks merely
 * quiet — which is exactly what a healthy pass with nothing to do produces. The
 * whole point of the run ledger is that those two become different answers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyRun, staleAfterMs, RUN_STATES } = require('../lib/operations/runHealth');

const NOW = Date.parse('2026-09-20T18:00:00Z');
const minutesAgo = (m) => new Date(NOW - m * 60000).toISOString();

const row = (over = {}) => ({
  serviceKey: 'fuel_risk',
  lastStartedAt: minutesAgo(5),
  lastFinishedAt: minutesAgo(5),
  lastStatus: 'ok',
  lastError: null,
  consecutiveFailures: 0,
  runsTotal: 40,
  failuresTotal: 0,
  expectedIntervalSeconds: 1200,
  ...over,
});

const at = (r, extra = {}) => classifyRun(r, { now: NOW, ...extra });

test('no record at all is "cannot determine" — never healthy', () => {
  const v = at(null);
  assert.equal(v.state, RUN_STATES.UNKNOWN);
  assert.equal(v.actionable, false, 'nobody is paged for a worker we have never heard from');
  assert.match(v.reason, /ever been recorded/);
});

test('a recent clean pass is healthy', () => {
  assert.equal(at(row()).state, RUN_STATES.HEALTHY);
});

test('a pass that correctly did nothing is healthy, and says which', () => {
  const v = at(row({ lastStatus: 'skipped' }));
  assert.equal(v.state, RUN_STATES.HEALTHY);
  assert.match(v.reason, /nothing was due/);
});

// ── the one nothing else can see ─────────────────────────────────────────────

test('a worker that has not finished a pass in several of its own intervals has STOPPED', () => {
  const v = at(row({ lastFinishedAt: minutesAgo(200) }));
  assert.equal(v.state, RUN_STATES.STALE,
    'twenty-minute worker, silent for over three hours');
  assert.equal(v.actionable, true);
});

test('a slow worker is not called stopped for being slow', () => {
  const v = at(row({ lastFinishedAt: minutesAgo(200), expectedIntervalSeconds: 21600 }));
  assert.equal(v.state, RUN_STATES.HEALTHY,
    'a six-hourly pass that ran three hours ago is exactly on schedule');
});

test('staleness is decided BEFORE the status', () => {
  const v = at(row({ lastStatus: 'error', consecutiveFailures: 1, lastFinishedAt: minutesAgo(400) }));
  assert.equal(v.state, RUN_STATES.STALE,
    'a worker that failed once and then stopped ticking reads `error` forever; '
    + 'the useful fact is that nothing has run since');
});

test('a fast worker is given a floor, so a one-minute job is not stale after three', () => {
  assert.equal(staleAfterMs(60), 15 * 60 * 1000);
});

test('however slow the worker, silence eventually counts', () => {
  assert.equal(staleAfterMs(86400 * 9), 3 * 24 * 3600 * 1000);
});

// ── failure, graded ──────────────────────────────────────────────────────────

test('one failure is degraded, not an incident', () => {
  const v = at(row({ lastStatus: 'error', consecutiveFailures: 1, failuresTotal: 1 }));
  assert.equal(v.state, RUN_STATES.DEGRADED);
  assert.equal(v.actionable, false, 'integrations blip; announcing this is how a channel becomes unread');
});

test('three in a row is a real failure', () => {
  const v = at(row({ lastStatus: 'error', consecutiveFailures: 3, failuresTotal: 3 }));
  assert.equal(v.state, RUN_STATES.FAILING);
  assert.equal(v.actionable, true);
});

test('eight in a row means the automatic recovery has had its chance', () => {
  const v = at(row({ lastStatus: 'error', consecutiveFailures: 8, failuresTotal: 8 }));
  assert.equal(v.state, RUN_STATES.NEEDS_ATTENTION);
  assert.match(v.reason, /not recovering on its own/);
});

test('a clean pass after failures is a recovery, said once', () => {
  const v = at(row({
    consecutiveFailures: 0, failuresTotal: 4,
    lastOkAt: minutesAgo(5), lastErrorAt: minutesAgo(40), lastFinishedAt: minutesAgo(5),
  }));
  assert.equal(v.state, RUN_STATES.RECOVERED);
});

test('a worker that failed months ago and has been fine since is simply healthy', () => {
  const v = at(row({
    consecutiveFailures: 0, failuresTotal: 4,
    lastErrorAt: new Date(NOW - 30 * 24 * 3600000).toISOString(),
  }));
  assert.equal(v.state, RUN_STATES.HEALTHY, 'a recovery is news for a few hours, not forever');
});

// ── configuration is not failure ─────────────────────────────────────────────

test('blocked on configuration needs a person and names what is missing', () => {
  const v = at(row({ lastStatus: 'blocked', lastError: 'no Telegram destination configured' }));
  assert.equal(v.state, RUN_STATES.NEEDS_ATTENTION);
  assert.equal(v.reason, 'no Telegram destination configured');
});

test('the first pass after a deploy is not yet due, not stopped', () => {
  const v = classifyRun(row({ lastFinishedAt: minutesAgo(600) }), {
    now: NOW, bootedAtMs: NOW - 60000, firstRunDelaySeconds: 600,
  });
  assert.equal(v.state, RUN_STATES.HEALTHY,
    'every deploy passes through this window; calling it stopped would make the '
    + 'state meaningless for ten minutes after every release');
});

test('a worker with no expected interval is never called stale, because nothing says what late means', () => {
  const v = at(row({ lastFinishedAt: minutesAgo(5000), expectedIntervalSeconds: null }));
  assert.notEqual(v.state, RUN_STATES.STALE);
});

/**
 * "Waiting on a person" and "failing" both read as `needs_human_attention`, and
 * only one of them is a fault. A caller reporting a component as WORKING OR NOT
 * needs to tell them apart; `actionable` deliberately cannot.
 */
test('a blocked verdict says so, and a failing one does not', () => {
  const off = at(row({ lastStatus: 'blocked', lastError: 'the Dispatcher Board is switched off' }));
  assert.equal(off.blocked, true);
  assert.equal(off.actionable, true, 'somebody still has to look at it');

  const broken = at(row({ lastStatus: 'error', consecutiveFailures: 12, lastError: 'boom' }));
  assert.equal(broken.state, RUN_STATES.NEEDS_ATTENTION, 'same state');
  assert.equal(broken.blocked, false, 'but not the same cause');
});
