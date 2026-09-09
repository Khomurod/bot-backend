/**
 * Two sweeps must never run at once, whoever started them.
 *
 * The guard is not about load. `resolveClearedFindings` closes every open
 * finding for the checks that ran EXCEPT the ids the sweep just filed, so two
 * overlapping sweeps carry two different `keepIds` sets. If the one that
 * started FIRST commits LAST, it resolves findings the newer sweep had just
 * re-filed — quietly clearing real problems off the page until some later run
 * happens to notice them again.
 *
 * The scheduled tick always held that guard. The admin's "Run checks now"
 * button called the unguarded function directly and walked straight past it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { runGuardedSweep } = require('../services/operations/consistencyService');

/**
 * A database that answers nothing, optionally hanging until released.
 *
 * Every sweep below runs with `apply: false`, which returns before the findings
 * store is touched. That store holds its own pool binding, and the guard being
 * tested here is mutual exclusion — identical either way — so a dry run
 * exercises it without needing a database at all.
 */
function fakeDb({ gate = null, onQuery = () => {} } = {}) {
  return {
    async query() {
      onQuery();
      if (gate) await gate;
      return { rows: [] };
    },
  };
}

test('a second sweep started mid-run is refused, and says so', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let queries = 0;
  const db = fakeDb({ gate, onQuery: () => { queries += 1; } });

  const first = runGuardedSweep({ apply: false, db });
  // Let the first sweep issue its snapshot queries (five, in a Promise.all)
  // before measuring, so the count below is the FIRST sweep's alone.
  await new Promise((resolve) => { setImmediate(resolve); });
  const issuedByFirst = queries;

  const second = await runGuardedSweep({ apply: false, db });

  assert.deepEqual(second, {
    skipped: true, reason: 'A sweep is already running; this one was not started.',
  });
  assert.equal(queries, issuedByFirst, 'the refused call issued no query of its own');

  release();
  await first;
});

test('the guard releases, so the next sweep runs normally', async () => {
  let queries = 0;
  const db = fakeDb({ onQuery: () => { queries += 1; } });

  await runGuardedSweep({ apply: false, db });
  const after = queries;
  await runGuardedSweep({ apply: false, db });

  assert.ok(queries > after, 'a finished sweep must not leave the door locked behind it');
});

test('a throwing sweep still releases the guard', async () => {
  const exploding = { async query() { throw new Error('database went away'); } };
  await assert.rejects(() => runGuardedSweep({ apply: false, db: exploding }), /database went away/);

  let ran = false;
  await runGuardedSweep({ apply: false, db: fakeDb({ onQuery: () => { ran = true; } }) });

  assert.equal(ran, true,
    'a failed sweep must not wedge the guard shut and stop every later one, including the timer');
});
