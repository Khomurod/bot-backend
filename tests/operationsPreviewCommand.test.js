/**
 * `npm run operations:preview` — the command a 65-row production repair is
 * reviewed and run from.
 *
 * Three things it got wrong, all of the same kind: the command told the operator
 * something that was not true.
 *
 *   - `--sweep` without `--apply` wrote to the database, under a header
 *     promising that nothing is written without `--apply`;
 *   - a check with more eligible findings than the cap's hard maximum printed a
 *     "fix" that cannot unblock it, because `wanted > cap` is the refusal test
 *     and the column is CHECKed to 500;
 *   - an `--apply` run that applied nothing, or failed, still exited 0, so a
 *     runbook recorded a no-op repair as a success.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.BOT_TOKEN ||= 'test';
process.env.TELEGRAM_BOT_TOKEN ||= 'test';
process.env.JWT_SECRET ||= 'test';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef';

const {
  main, capAdvice, exitCodeFor, MAX_AUTO_PER_RUN,
} = require('../scripts/operations-preview');

function emptySummary(overrides = {}) {
  return {
    open: 0, eligible: 0, applied: 0, stale: 0, failed: 0,
    skipped: { disabled: 0, noPayload: 0, noAction: 0 },
    ...overrides,
  };
}

function deps({ sweepCalls = [], autoCalls = [], autoResult } = {}) {
  return {
    runGuardedSweep: async (options) => {
      sweepCalls.push(options);
      return { summary: { found: 3, filed: 0, resolved: 0, dryRun: true, failures: [] } };
    },
    runAutoCorrections: async (options) => {
      autoCalls.push(options);
      return autoResult || { summary: emptySummary(), plan: [], capped: [], results: [] };
    },
    listCheckSettings: async () => [],
    log: { log() {}, error() {} },
  };
}

test('--sweep without --apply does NOT write', async () => {
  const sweepCalls = [];
  await main(['node', 'x', '--sweep'], deps({ sweepCalls }));
  assert.equal(sweepCalls.length, 1);
  assert.equal(sweepCalls[0].apply, false,
    'the header promises nothing is written without --apply; the sweep files findings and resolves cleared ones');
});

test('--sweep --apply does write', async () => {
  const sweepCalls = [];
  await main(['node', 'x', '--sweep', '--apply'], deps({ sweepCalls }));
  assert.equal(sweepCalls[0].apply, true);
});

test('the dry run never reaches the apply path', async () => {
  const autoCalls = [];
  await main(['node', 'x'], deps({ autoCalls }));
  assert.equal(autoCalls[0].apply, false);
});

test('a cap that CAN unblock the batch is the advice', () => {
  const [advice] = capAdvice([{ checkKey: 'home_time.closable_open_cycle', wanted: 65, cap: 50 }]);
  assert.equal(advice.raisable, true);
  assert.match(advice.fix, /"maxAutoPerRun": 65/);
  assert.ok(65 <= MAX_AUTO_PER_RUN);
});

test('a batch past the hard maximum is NOT told to raise the cap', () => {
  // `planForCheck` refuses whenever `wanted > cap`, and
  // `max_auto_per_run` is CHECKed BETWEEN 1 AND 500. Printing "set it to 500"
  // for 501 eligible findings is an instruction that leaves the operator
  // capped forever, having done what the tool told them to.
  const [advice] = capAdvice([{ checkKey: 'x', wanted: 501, cap: 50 }]);
  assert.equal(advice.raisable, false);
  assert.doesNotMatch(advice.fix, /maxAutoPerRun/,
    'no PUT can fix this; saying so is the only honest output');
  assert.match(advice.fix, /cannot/i);
});

test('exactly the hard maximum is still raisable', () => {
  const [advice] = capAdvice([{ checkKey: 'x', wanted: MAX_AUTO_PER_RUN, cap: 50 }]);
  assert.equal(advice.raisable, true, 'the refusal is wanted > cap, so cap = wanted passes');
});

test('a dry run always succeeds — reporting is its whole job', () => {
  assert.equal(exitCodeFor({
    apply: false, summary: emptySummary(), capped: [{ checkKey: 'x', wanted: 65, cap: 50 }],
  }), 0);
});

test('an apply that applied nothing because of the cap fails', () => {
  assert.equal(exitCodeFor({
    apply: true, summary: emptySummary(), capped: [{ checkKey: 'x', wanted: 65, cap: 50 }],
  }), 1, 'a runbook must not record a blocked repair as a success');
});

test('an apply with a failed correction fails', () => {
  assert.equal(exitCodeFor({
    apply: true, summary: emptySummary({ applied: 4, failed: 1 }), capped: [],
  }), 1);
});

test('an apply with a broken check module fails', () => {
  assert.equal(exitCodeFor({
    apply: true, summary: emptySummary({ applied: 4 }), capped: [],
    sweep: { failures: [{ module: 'identity', error: 'boom' }] },
  }), 1, 'a sweep that lost a check ran an incomplete plan');
});

test('a clean apply succeeds', () => {
  assert.equal(exitCodeFor({
    apply: true, summary: emptySummary({ applied: 65 }), capped: [], sweep: { failures: [] },
  }), 0);
});

test('an apply that had nothing to do succeeds', () => {
  assert.equal(exitCodeFor({ apply: true, summary: emptySummary(), capped: [] }), 0,
    'zero eligible and zero capped is a real, correct no-op');
});

test('main returns the exit code rather than exiting', async () => {
  const code = await main(['node', 'x', '--apply'], deps({
    autoResult: {
      summary: emptySummary({ applied: 1, failed: 2 }), plan: [], capped: [], results: [],
    },
  }));
  assert.equal(code, 1);
});
