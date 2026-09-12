'use strict';

/**
 * The Board poller — what a pass does, and more importantly what a FAILED pass
 * must not do.
 *
 * The one that would cost real money is `markAbsent`: "we could not read the
 * board" and "nobody is on the board" are opposite facts, and a poller that
 * confused them would retire the whole fleet every time the spreadsheet had a
 * bad afternoon. Every failure path below asserts the snapshot was left alone.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  runBoardPoll, SERVICE_KEY,
} = require('../services/dispatchBoard/poller');

const CONFIGURED = {
  enabled: true,
  configured: true,
  baseUrl: 'https://script.example.test/exec',
  token: 'board-token-value',
  pollIntervalSeconds: 300,
};

/** A deps set whose every call is recorded, so "was not called" is assertable. */
function makeDeps(overrides = {}) {
  const calls = { fetch: 0, upsert: 0, absent: 0, outcomes: [] };
  const deps = {
    settings: {
      getBoardConfig: async () => CONFIGURED,
      recordPollOutcome: async (o) => { calls.outcomes.push(o); return o.error || null; },
      ...(overrides.settings || {}),
    },
    client: {
      fetchBoard: async () => {
        calls.fetch += 1;
        return { json: { rows: [{ driver: 'ALPHA ONE', truck: '001' }] } };
      },
      ...(overrides.client || {}),
    },
    store: {
      upsertBoardRows: async () => {
        calls.upsert += 1;
        return { inserted: 1, updated: 0, unchanged: 0, skipped: 0 };
      },
      markAbsent: async () => { calls.absent += 1; return 0; },
      ...(overrides.store || {}),
    },
  };
  // A stub that counts has to survive being replaced by an override.
  if (overrides.client?.fetchBoard) {
    const inner = overrides.client.fetchBoard;
    deps.client.fetchBoard = async (...args) => { calls.fetch += 1; return inner(...args); };
  }
  if (overrides.store?.upsertBoardRows) {
    const inner = overrides.store.upsertBoardRows;
    deps.store.upsertBoardRows = async (...args) => { calls.upsert += 1; return inner(...args); };
  }
  if (overrides.store?.markAbsent) {
    const inner = overrides.store.markAbsent;
    deps.store.markAbsent = async (...args) => { calls.absent += 1; return inner(...args); };
  }
  // The real `applyBoardPass` runs both inside ONE transaction. The stub
  // composes the same two calls in the same order, so every assertion below
  // about what was and was not called still means what it says — and the order
  // is what makes "a store failure retires nobody" observable.
  if (!overrides.store?.applyBoardPass) {
    deps.store.applyBoardPass = async (rows, keepKeys) => {
      const counts = await deps.store.upsertBoardRows(rows);
      const absent = await deps.store.markAbsent(keepKeys);
      return { ...counts, absent };
    };
  }
  return { deps, calls };
}

test('the service key is the one the catalogue knows', () => {
  const { getServiceEntry } = require('../lib/operations/backgroundServiceCatalog');
  const entry = getServiceEntry(SERVICE_KEY);
  assert.ok(entry, 'dispatch_board_poll must be catalogued');
  assert.strictEqual(entry.configurable, true);
});

test('switched off is blocked, not an error, and reads nothing', async () => {
  const { deps, calls } = makeDeps({
    settings: { getBoardConfig: async () => ({ ...CONFIGURED, enabled: false }) },
  });
  const summary = await runBoardPoll({ deps });
  assert.match(summary.blocked, /switched off/i);
  assert.strictEqual(summary.error, undefined);
  assert.strictEqual(calls.fetch, 0);
  assert.strictEqual(calls.absent, 0);
});

test('no address or token saved is blocked, not an error', async () => {
  const { deps, calls } = makeDeps({
    settings: { getBoardConfig: async () => ({ ...CONFIGURED, configured: false, token: '' }) },
  });
  const summary = await runBoardPoll({ deps });
  assert.match(summary.blocked, /address and token/i);
  assert.strictEqual(calls.fetch, 0);
});

test('a settings read that FAILS is an error, never "unconfigured"', async () => {
  const { deps, calls } = makeDeps({
    settings: {
      getBoardConfig: async () => { throw new Error('connection terminated unexpectedly'); },
    },
  });
  const summary = await runBoardPoll({ deps });
  assert.strictEqual(summary.blocked, undefined);
  assert.match(summary.error, /settings could not be read/i);
  assert.match(summary.error, /connection terminated/);
  assert.strictEqual(calls.fetch, 0);
});

test('a fetch failure records the error, returns it, and marks nobody absent', async () => {
  const { deps, calls } = makeDeps({
    client: {
      fetchBoard: async () => { throw new Error('the board did not answer in time'); },
    },
  });
  const summary = await runBoardPoll({ deps });
  assert.match(summary.error, /did not answer in time/);
  assert.strictEqual(calls.upsert, 0);
  assert.strictEqual(calls.absent, 0, 'a failed read must never retire a row');
  assert.deepStrictEqual(calls.outcomes.map((o) => o.ok), [false]);
});

test('the stored error carries no URL and no token', async () => {
  const { deps, calls } = makeDeps({
    client: {
      fetchBoard: async () => {
        throw new Error('request to https://script.example.test/exec?token=board-token-value failed');
      },
    },
  });
  const summary = await runBoardPoll({ deps });
  assert.ok(!summary.error.includes('board-token-value'), summary.error);
  assert.ok(!summary.error.includes('script.example.test'), summary.error);
  assert.ok(!calls.outcomes[0].error.includes('board-token-value'));
});

test('an answer with no rows in it is an error, and retires nothing', async () => {
  const { deps, calls } = makeDeps({
    client: { fetchBoard: async () => ({ json: { message: 'forbidden' } }) },
  });
  const summary = await runBoardPoll({ deps });
  assert.match(summary.error, /no rows could be found/i);
  assert.strictEqual(calls.upsert, 0);
  assert.strictEqual(calls.absent, 0);
});

test('a store failure is an error, and absent rows are not written either', async () => {
  const { deps, calls } = makeDeps({
    store: {
      upsertBoardRows: async () => { throw new Error('relation "dispatch_board_rows" does not exist'); },
    },
  });
  const summary = await runBoardPoll({ deps });
  assert.match(summary.error, /could not be stored/i);
  assert.strictEqual(calls.absent, 0);
  assert.strictEqual(calls.outcomes[0].ok, false);
});

test('a good pass counts what it did and records a successful outcome', async () => {
  const { deps, calls } = makeDeps({
    client: {
      fetchBoard: async () => ({
        json: {
          board_date: '2026-09-12',
          rows: [
            { driver: 'ALPHA ONE (COMPANY DRIVER)', truck: '001', status: 'DISPATCHED' },
            { driver: 'BETA TWO', truck: '002', status: 'HOME' },
          ],
        },
      }),
    },
    store: {
      upsertBoardRows: async (rows) => {
        assert.strictEqual(rows.length, 2);
        return { inserted: 2, updated: 0, unchanged: 0 };
      },
      markAbsent: async (keys) => { assert.strictEqual(keys.length, 2); return 3; },
    },
  });
  const summary = await runBoardPoll({ deps });
  assert.strictEqual(summary.error, undefined);
  assert.strictEqual(summary.read, 2);
  assert.strictEqual(summary.inserted, 2);
  assert.strictEqual(summary.absent, 3);
  assert.strictEqual(typeof summary.problems, 'number');
  assert.strictEqual(calls.outcomes[0].ok, true);
  assert.strictEqual(calls.outcomes[0].boardDate, '2026-09-12');
});

test('the poller sends nothing and decides nothing', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../services/dispatchBoard/poller'), 'utf8');
  // Not a comment scan: these are the require paths that would give a
  // spreadsheet read the power to message a driver or change stored state.
  for (const forbidden of [
    /require\([^)]*notifications?[^)]*\)/i,
    /require\([^)]*telegram[^)]*\)/i,
    /require\([^)]*corrections[^)]*\)/i,
    /require\([^)]*takeDecision[^)]*\)/i,
  ]) {
    assert.ok(!forbidden.test(src), `poller must not import ${forbidden}`);
  }
});

test('a well-formed answer carrying zero rows retires nobody', async () => {
  const { deps, calls } = makeDeps({
    client: { fetchBoard: async () => ({ json: { board_date: '2026-09-12', rows: [] } }) },
  });
  const summary = await runBoardPoll({ deps });
  assert.match(summary.error, /no rows at all/i);
  assert.strictEqual(calls.upsert, 0);
  assert.strictEqual(
    calls.absent, 0,
    'markAbsent([]) retires the whole fleet — an empty answer must never reach it'
  );
  assert.strictEqual(calls.outcomes[0].ok, false);
});

// ── Codex review, #214 ───────────────────────────────────────────────────────

test('a payload of empty objects retires nobody, even though it parsed', async () => {
  // `{"rows":[{}]}` is what an Apps Script produces when both identifying
  // column names change. The parser keeps the row and reports it, so `count`
  // is 1 and the zero-row guard does not fire — but every key is null, and
  // `markAbsent` filters nulls out, so the keep-list is empty and the whole
  // fleet would be retired. The guard is about IDENTIFIABLE rows, not rows.
  const { deps, calls } = makeDeps({
    client: { fetchBoard: async () => ({ json: { rows: [{}, {}] } }) },
  });
  const summary = await runBoardPoll({ deps });
  assert.match(summary.error, /none of which could be identified/i);
  assert.strictEqual(calls.absent, 0, 'an unreadable answer must never retire a row');
  assert.strictEqual(calls.upsert, 0);
});

test('a row with a truck and no driver is skipped, not written as a null name', async () => {
  // `driver_name_raw` is NOT NULL. The tolerant parser keeps a row with a truck
  // and a blank driver cell and keys it `001|?`, so handing it to the insert
  // raises a constraint error — and because one spreadsheet cell caused it, the
  // SAME pass fails every five minutes and no later row is ever refreshed.
  let stored = null;
  const { deps, calls } = makeDeps({
    client: {
      fetchBoard: async () => ({
        json: {
          rows: [
            { driver: 'ALPHA ONE (COMPANY DRIVER)', truck: '001', status: 'HOME' },
            { driver: '', truck: '002', status: 'READY' },
          ],
        },
      }),
    },
    store: {
      upsertBoardRows: async (rows) => {
        stored = rows;
        return { inserted: rows.length, updated: 0, unchanged: 0 };
      },
    },
  });
  const summary = await runBoardPoll({ deps });
  assert.strictEqual(summary.error, undefined, summary.error);
  assert.ok(stored, 'the good row must still be stored');
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].truckNorm, '001');
  for (const row of stored) {
    assert.ok(row.driverNameRaw, 'no row reaching the store may have a null driver name');
  }
  assert.strictEqual(summary.skipped, 1);
  assert.strictEqual(calls.absent, 1);
});

test('the keep-list is exactly what was stored, never what was read', async () => {
  let keep = null;
  const { deps } = makeDeps({
    client: {
      fetchBoard: async () => ({
        json: {
          rows: [
            { driver: 'ALPHA ONE', truck: '001' },
            { driver: '', truck: '002' },
            {},
          ],
        },
      }),
    },
    store: { markAbsent: async (keys) => { keep = keys; return 0; } },
  });
  await runBoardPoll({ deps });
  assert.strictEqual(keep.length, 1, 'only the one storable row may hold its place');
  assert.ok(keep[0].startsWith('001|'), keep[0]);
  assert.ok(keep.every(Boolean), 'one null key in the keep-list empties the whole list');
});
