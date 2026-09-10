/**
 * The sweep that finds a problem is the sweep that fixes it — in the background.
 *
 * Stage 3 built the correction registry and Stage 4 gave the admin a per-check
 * "Auto-apply" switch. Neither did anything on its own: `runAutoCorrections` was
 * reachable only from the admin's dry-run preview and a shell script, so a check
 * an operator had explicitly enabled still corrected nothing until somebody ran
 * a command by hand. "Automatic" has to mean the timer does it.
 *
 * It runs INSIDE the sweep guard, after the findings are filed. Corrections
 * change the rows the next sweep reads, and `resolveClearedFindings` decides
 * what "no longer true" means from those rows — so a correction run racing a
 * sweep is the same overlap bug the guard exists to prevent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const AUTO_APPLY = path.resolve(__dirname, '../services/operations/corrections/autoApply.js');
const SERVICE = path.resolve(__dirname, '../services/operations/consistencyService.js');

const calls = [];
let behaviour = async () => ({ summary: { applied: 2, stale: 0, failed: 0 }, results: [], capped: [] });

require.cache[AUTO_APPLY] = {
  exports: {
    DEFAULT_CAP: 50,
    async runAutoCorrections(opts) {
      calls.push(opts);
      return behaviour(opts);
    },
  },
};
delete require.cache[SERVICE];
const { runGuardedSweep, getConsistencyStatus } = require(SERVICE);

const db = { async query() { return { rows: [] }; } };
const store = {
  SEVERITIES: ['info', 'warning', 'serious'],
  TIERS: ['auto', 'approval', 'warning'],
  async upsertFinding() { return null; },
  async resolveClearedFindings() { return 0; },
};

test('a real sweep runs the corrections, on the SAME db and store', async () => {
  calls.length = 0;
  const result = await runGuardedSweep({ db, store });
  assert.equal(calls.length, 1, 'the timer path must correct, not only find');
  assert.equal(calls[0].apply, true);
  assert.equal(calls[0].db, db, 'a different db would split one run across two databases');
  assert.equal(calls[0].store, store);
  assert.equal(result.corrections.summary.applied, 2);
  assert.equal(getConsistencyStatus().lastCorrections.summary.applied, 2);
});

test('a dry-run sweep corrects nothing', async () => {
  calls.length = 0;
  await runGuardedSweep({ apply: false, db, store });
  assert.equal(calls.length, 0, 'preview means preview');
});

test('the caller can find without correcting', async () => {
  calls.length = 0;
  await runGuardedSweep({ db, store, correct: false });
  assert.equal(calls.length, 0);
});

test('a correction run that throws does not lose the sweep, and is recorded', async () => {
  calls.length = 0;
  behaviour = async () => { throw new Error('registry exploded'); };
  try {
    const result = await runGuardedSweep({ db, store });
    assert.ok(result.summary, 'the findings were still filed and the summary returned');
    assert.equal(result.corrections.error, 'registry exploded');
    assert.equal(getConsistencyStatus().lastCorrections.error, 'registry exploded');
  } finally {
    behaviour = async () => ({ summary: { applied: 0, stale: 0, failed: 0 }, results: [], capped: [] });
  }
});
