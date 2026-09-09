/**
 * The per-run cap, at the boundary where measuring a page of rows stops working.
 *
 * The cap's whole job is to refuse when a check wants to change more rows than
 * an operator allowed. Deciding that from a fetched page cannot distinguish
 * "exactly the cap" from "the cap and more", because a LIMIT truncates silently
 * — so at the top of the permitted range (cap 500, 501 eligible findings) the
 * guardrail read a truncated page as compliant and applied 500 corrections
 * instead of the zero it promised.
 *
 * No database here on purpose: the store is a stub that truncates at whatever
 * limit it is handed, which is the one behaviour of the real one that matters to
 * this bug, and 501 findings are free to make up.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { runAutoCorrections, DEFAULT_CAP } = require('../services/operations/corrections/autoApply');

const CHECK = 'home_time.closable_open_cycle';

function makeFindings(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    checkKey: CHECK,
    tier: 'auto',
    proposedChange: {
      id: 1000 + i,
      returnToRoadAt: { from: null, to: '2026-08-31T00:00:00Z' },
      homeDays: { from: null, to: 6 },
    },
  }));
}

/** A findings store that behaves like the real one in the only way that counts. */
function stubStore(findings) {
  const calls = [];
  const match = ({ checkKey = null, tier = null }) => findings.filter(
    (f) => (!checkKey || f.checkKey === checkKey) && (!tier || f.tier === tier)
  );
  return {
    calls,
    listFindings(opts = {}) {
      calls.push({ op: 'list', ...opts });
      return Promise.resolve(match(opts).slice(0, opts.limit ?? 200));
    },
    countFindings(opts = {}) {
      calls.push({ op: 'count', ...opts });
      return Promise.resolve(match(opts).length);
    },
    upsertFinding: (f) => Promise.resolve({ id: 0, ...f }),
  };
}

function stubDb(cap) {
  return {
    query: () => Promise.resolve({
      rows: [{ check_key: CHECK, auto_apply_enabled: true, max_auto_per_run: cap }],
    }),
  };
}

test('one more finding than the maximum cap applies nothing at all', async () => {
  const store = stubStore(makeFindings(501));

  const { summary, plan, capped } = await runAutoCorrections({ db: stubDb(500), store });

  assert.deepEqual(capped, [{ checkKey: CHECK, wanted: 501, cap: 500 }],
    'the self-report must say 501, not a truncated 500');
  assert.equal(plan.length, 0, 'a capped check changes NOTHING — that is the guardrail');
  assert.equal(summary.eligible, 0);
});

test('the cap is decided by a count, never by the size of a fetched page', async () => {
  const store = stubStore(makeFindings(501));

  await runAutoCorrections({ db: stubDb(500), store });

  const listed = store.calls.filter((c) => c.op === 'list');
  assert.equal(listed.length, 0, 'a capped check must not even fetch the rows it refuses');
  const counted = store.calls.filter((c) => c.op === 'count' && c.checkKey === CHECK);
  assert.ok(counted.length >= 1, 'the decision comes from a COUNT');
});

test('exactly the cap still applies, and asks for one more row than it needs', async () => {
  const store = stubStore(makeFindings(500));

  const { plan } = await runAutoCorrections({ db: stubDb(500), store });

  assert.equal(plan.length, 500, 'the cap is a maximum, not an off-by-one');
  const listed = store.calls.find((c) => c.op === 'list' && c.checkKey === CHECK);
  assert.ok(listed.limit > 500,
    'listing at exactly the cap could not detect a finding that appeared since the count');
  assert.equal(listed.tier, 'auto', 'a non-auto finding must not consume a slot');
});

test('a check nobody has enabled reports how much is waiting for permission', async () => {
  const store = stubStore(makeFindings(3));

  const { summary } = await runAutoCorrections({
    db: { query: () => Promise.resolve({ rows: [] }) }, store,
  });

  assert.equal(summary.eligible, 0);
  assert.equal(summary.skipped.disabled, 3, 'default deny, and say what it is denying');
  assert.equal(summary.dryRun, true);
});

test('the default cap applies when a settings row does not name one', async () => {
  const store = stubStore(makeFindings(DEFAULT_CAP + 1));

  const { capped } = await runAutoCorrections({
    db: {
      query: () => Promise.resolve({
        rows: [{ check_key: CHECK, auto_apply_enabled: true, max_auto_per_run: null }],
      }),
    },
    store,
  });

  assert.deepEqual(capped, [{ checkKey: CHECK, wanted: DEFAULT_CAP + 1, cap: DEFAULT_CAP }]);
});
