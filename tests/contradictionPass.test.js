/**
 * Two features disagreeing about one driver, and what Wenze does about it.
 *
 * `lib/drivers/context.js` and `database/driverContext.js` were written, tested
 * and called by NOTHING — the second not even by a test file. This is the
 * caller that was missing, and these are tests of the thing it must never do.
 *
 * THE ONE THAT MATTERS: it does not pick a side. There is no correct automatic
 * answer to Home Time and the load board disagreeing about a human, and a tier
 * that permitted one would be the most dangerous setting in this application.
 * Every assertion about `tier` below is there to fail if somebody ever decides
 * the more recent row wins.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const pass = require('../services/operations/contradictionPass');

const NOW = '2026-09-20T18:00:00Z';
const hoursAgo = (h) => new Date(Date.parse(NOW) - h * 3600000).toISOString();

/** A context in the shape `describeContext` produces. */
function context(overrides = {}) {
  const known = (v) => ({ known: true, ...v });
  return {
    personId: 11,
    identity: known({ displayName: 'JOHN DOE', openUnits: ['310'], openGroups: [7] }),
    homeTime: known({ state: 'road', stateSince: hoursAgo(200) }),
    loads: known({ movingPhase: null, orderId: null }),
    fuel: known({ fuelPercent: 60, newestReadingAt: hoursAgo(1) }),
    safety: known({ events: 0, newestEventAt: null, windowDays: 30 }),
    retention: known({ goneQuiet: false, urgency: null }),
    ...overrides,
  };
}

const AT_HOME_AND_DRIVING = context({
  homeTime: { known: true, state: 'home', stateSince: hoursAgo(72) },
  loads: { known: true, movingPhase: 'in_transit', orderId: 'ORD-9' },
});

function harness({ candidates = [11], ctx = AT_HOME_AND_DRIVING, screenThrows = false,
  readThrows = false } = {}) {
  const calls = { filed: [], notified: [], read: [] };
  const deps = {
    context: {
      async listContradictionCandidates() {
        if (screenThrows) throw new Error('connection terminated');
        return candidates;
      },
      async getDriverContext(personId) {
        calls.read.push(personId);
        if (readThrows) throw new Error('relation does not exist');
        return typeof ctx === 'function' ? ctx(personId) : ctx;
      },
    },
    findings: { async upsertFinding(f) { calls.filed.push(f); return { id: calls.filed.length }; } },
    async notify(n) { calls.notified.push(n); return { recorded: true, delivered: true }; },
  };
  return { deps, calls };
}

// ── it reports, and does not decide ──────────────────────────────────────────

test('A DISAGREEMENT IS FILED FOR A PERSON TO SETTLE, NEVER APPLIED', async () => {
  const { deps, calls } = harness();
  const summary = await pass.runContradictionPass({ now: NOW, deps });

  assert.equal(summary.filed, 1);
  const finding = calls.filed[0];
  assert.equal(finding.tier, 'warning', 'the tier with no apply action at all');
  assert.equal(finding.proposedChange, null, 'there is no change to propose — that is the point');
  assert.equal(finding.confidence, null, 'and no confidence, because nothing was concluded');
  assert.equal(finding.checkKey, 'context.home_while_working');
  assert.equal(finding.subjectType, 'person');
  assert.equal(finding.subjectId, 11, 'about the human, not the chat');
});

test('it names BOTH sides and what each was reading', async () => {
  const { deps, calls } = harness();
  await pass.runContradictionPass({ now: NOW, deps });

  const { evidence } = calls.filed[0];
  assert.deepEqual(evidence.sides, ['home_time', 'loads']);
  assert.match(evidence.summary, /at home since/);
  assert.match(evidence.summary, /in_transit/);
  assert.equal(evidence.orderId, 'ORD-9', 'with the row a person can go and look at');
});

test('the notice tells a person to decide, and does not suggest an answer', async () => {
  const { deps, calls } = harness();
  await pass.runContradictionPass({ now: NOW, deps });

  const notice = calls.notified[0];
  assert.equal(notice.category, 'needs_attention');
  assert.match(notice.action, /will not pick a side/);
  assert.equal(notice.personId, 11);
});

test('NO FACTS TRAVEL WITH IT, so nothing can argue a contradiction is urgent', async () => {
  // A distance or a deadline would let the priority rules escalate. There is
  // neither here, and inventing one to make this look serious would be the
  // fabrication the priority module exists to refuse.
  const { deps, calls } = harness();
  await pass.runContradictionPass({ now: NOW, deps });
  assert.equal(calls.notified[0].facts, undefined);
});

// ── the one that is not about a driver at all ────────────────────────────────

test('QUIET IN ONE PLACE AND BUSY IN ANOTHER IS A BROKEN FEED, and it says so', async () => {
  const { deps, calls } = harness({
    ctx: context({
      retention: { known: true, goneQuiet: true, goneQuietSince: hoursAgo(48) },
      fuel: { known: true, fuelPercent: 55, newestReadingAt: hoursAgo(2) },
    }),
  });
  await pass.runContradictionPass({ now: NOW, deps });

  assert.equal(calls.filed[0].checkKey, 'context.quiet_but_active');
  assert.match(calls.filed[0].evidence.summary, /source that stopped\s+reporting/,
    'a driver who drove this morning has not gone quiet — a feed has');
});

test('two trucks open at once is the serious one', async () => {
  const { deps, calls } = harness({
    ctx: context({
      identity: { known: true, displayName: 'JOHN DOE', openUnits: ['310', '322'], openGroups: [7] },
    }),
  });
  await pass.runContradictionPass({ now: NOW, deps });
  assert.equal(calls.filed[0].checkKey, 'context.two_open_units');
  assert.equal(calls.filed[0].severity, 'serious');
});

test('one driver with two disagreements files two rows, not one blurred together', async () => {
  const { deps, calls } = harness({
    ctx: context({
      homeTime: { known: true, state: 'home', stateSince: hoursAgo(72) },
      loads: { known: true, movingPhase: 'in_transit', orderId: 'ORD-9' },
      identity: { known: true, displayName: 'JOHN DOE', openUnits: ['310', '322'], openGroups: [7] },
    }),
  });
  await pass.runContradictionPass({ now: NOW, deps });
  assert.equal(calls.filed.length, 2);
  assert.notEqual(calls.filed[0].checkKey, calls.filed[1].checkKey,
    'separate check keys, so resolving one does not silently close the other');
});

// ── a mostly blank page is not a clean bill of health ────────────────────────

test('COVERAGE TRAVELS WITH THE FINDING, because three unreadable sources is not "fine"', async () => {
  const { deps, calls } = harness({
    ctx: context({
      homeTime: { known: true, state: 'home', stateSince: hoursAgo(72) },
      loads: { known: true, movingPhase: 'in_transit', orderId: 'ORD-9' },
      fuel: { known: false },
      safety: { known: false },
      retention: { known: false },
    }),
  });
  await pass.runContradictionPass({ now: NOW, deps });

  assert.deepEqual(calls.filed[0].evidence.coverage.missing, ['fuel', 'safety', 'retention']);
  assert.equal(calls.filed[0].evidence.coverage.known, 3);
  assert.ok(calls.notified[0].lines.some((l) => /Read 3 of 6 sources/.test(l)),
    'and the reader is told, rather than left to assume the picture was complete');
});

test('a driver with no disagreement files nothing and says nothing', async () => {
  const { deps, calls } = harness({ ctx: context() });
  const summary = await pass.runContradictionPass({ now: NOW, deps });
  assert.equal(summary.filed, 0);
  assert.equal(summary.read, 1, 'but it was read — which is not the same as not running');
  assert.equal(calls.notified.length, 0);
});

// ── failing honestly ─────────────────────────────────────────────────────────

test('THE SCREEN FAILING IS A FAILED PASS, NOT A CLEAN ONE', async () => {
  // eslint-disable-next-line global-require
  const { statusFromSummary } = require('../services/operations/runLedger');
  const { deps } = harness({ screenThrows: true });
  const summary = await pass.runContradictionPass({ now: NOW, deps });

  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0], /^screen: /);
  assert.equal(summary.candidates, 0);
  assert.equal(summary.read, 0, 'and it does not report having read anybody');

  // AND THE LEDGER HAS TO AGREE. `statusFromSummary` reads `summary.error`,
  // singular; `errors` is the per-driver list and it knows nothing about it.
  // A totally failed pass was therefore recorded as `ok`, which defeats the
  // Operations entry this pass was registered for in the first place.
  assert.equal(statusFromSummary(summary).status, 'error');
});

test('A PASS THAT READ NOBODY IT WAS ASKED TO READ HAS NOT RUN', async () => {
  // One unreadable driver is noise. Every candidate failing is a failed pass,
  // whatever the counters say — the same "seeing nothing is not success" rule
  // the return-to-road watch needed.
  // eslint-disable-next-line global-require
  const { statusFromSummary } = require('../services/operations/runLedger');
  const { deps } = harness({ candidates: [11, 12], readThrows: true });
  const summary = await pass.runContradictionPass({ now: NOW, deps });

  assert.equal(summary.read, 0);
  assert.equal(summary.errors.length, 2);
  assert.equal(statusFromSummary(summary).status, 'error');
  assert.match(summary.error, /none of the 2 candidate\(s\)/);
});

test('but one bad driver among several is not a failed pass', async () => {
  let n = 0;
  // eslint-disable-next-line global-require
  const { statusFromSummary } = require('../services/operations/runLedger');
  const { deps } = harness({
    candidates: [11, 12],
    ctx: () => {
      n += 1;
      if (n === 1) throw new Error('relation does not exist');
      return AT_HOME_AND_DRIVING;
    },
  });
  const summary = await pass.runContradictionPass({ now: NOW, deps });
  assert.equal(summary.read, 1);
  assert.equal(statusFromSummary(summary).status, 'ok',
    'it did its job for the driver it could read');
});

test('one unreadable driver costs that driver, not the rest of the fleet', async () => {
  let n = 0;
  const { deps, calls } = harness({
    candidates: [11, 12, 13],
    ctx: () => {
      n += 1;
      if (n === 2) throw new Error('relation "load_lifecycle" does not exist');
      return AT_HOME_AND_DRIVING;
    },
  });
  const summary = await pass.runContradictionPass({ now: NOW, deps });
  assert.equal(summary.read, 2);
  assert.equal(summary.filed, 2);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0], /person 12/);
  assert.equal(calls.read.length, 3, 'all three were attempted');
});

test('a generous screen is capped, and the cap is reported rather than hidden', async () => {
  const { deps, calls } = harness({ candidates: [1, 2, 3, 4, 5] });
  const summary = await pass.runContradictionPass({ now: NOW, deps, limit: 3 });
  assert.equal(summary.capped, true);
  assert.equal(calls.read.length, 3, 'the six-query read is bounded');
});
