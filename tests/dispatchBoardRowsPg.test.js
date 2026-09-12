'use strict';

/**
 * The Board snapshot against the real schema.
 *
 * Two behaviours here are expressed in SQL rather than JavaScript — whether a
 * row counts as changed, and what happens to a row that stops appearing — so a
 * stub could assert neither. This drives the real table.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { parseBoardPayload } = require('../lib/board/parse');

const ALL_MIGRATIONS = allMigrationsSql();

function board(rows) {
  return parseBoardPayload({ rows }).rows;
}

const SMITH = {
  row: 2, driver_name: 'JOHN SMITH (COMPANY DRIVER)', truck: '001',
  trailer: 'T-118', phone: '+15555550001', status: 'HOME', dispatcher: 'Ann',
};

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  return { h, store: h.loadDataLayer(['dispatchBoard']).dispatchBoard };
}

test('a first pass inserts, and reading it back gives the row it was given', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { store } = await setup(t);
  const counts = await store.upsertBoardRows(board([SMITH]));
  assert.deepEqual(counts, { inserted: 1, updated: 0, unchanged: 0, skipped: 0 });

  const [row] = await store.listBoardRows();
  assert.equal(row.cleanName, 'JOHN SMITH');
  assert.equal(row.fleetType, 'company');
  assert.equal(row.truckNorm, '001');
  assert.equal(row.truckDigits, '1', 'the weak key is stored beside the strong one');
  assert.equal(row.boardTrailer, 'T-118');
  assert.equal(row.status, 'HOME');
  assert.equal(row.present, true);
  assert.equal(row.personId, null, 'linking is a later stage');
});

test('an identical second pass changes nothing, and says so', { skip: skipWithoutPg() }, async (t) => {
  const { h, store } = await setup(t);
  await store.upsertBoardRows(board([SMITH]));
  const before = await h.query('SELECT last_changed_at FROM dispatch_board_rows');

  const counts = await store.upsertBoardRows(board([SMITH]));
  assert.deepEqual(counts, { inserted: 0, updated: 0, unchanged: 1, skipped: 0 });

  const after = await h.query('SELECT last_changed_at, last_seen_at FROM dispatch_board_rows');
  assert.equal(
    new Date(after.rows[0].last_changed_at).toISOString(),
    new Date(before.rows[0].last_changed_at).toISOString(),
    'reading a row again is not something happening to the driver'
  );
  assert.ok(after.rows[0].last_seen_at, 'but we did see it again');
});

test('a status change moves last_changed_at', { skip: skipWithoutPg() }, async (t) => {
  const { h, store } = await setup(t);
  await store.upsertBoardRows(board([SMITH]));
  const before = await h.query('SELECT last_changed_at FROM dispatch_board_rows');

  const counts = await store.upsertBoardRows(board([{ ...SMITH, status: 'DISPATCHED' }]));
  assert.deepEqual(counts, { inserted: 0, updated: 1, unchanged: 0, skipped: 0 });

  const after = await h.query('SELECT last_changed_at, status FROM dispatch_board_rows');
  assert.equal(after.rows[0].status, 'DISPATCHED');
  assert.ok(
    new Date(after.rows[0].last_changed_at) > new Date(before.rows[0].last_changed_at),
    'something happened to this driver'
  );
});

test('the sheet position moving is not a change', { skip: skipWithoutPg() }, async (t) => {
  const { h, store } = await setup(t);
  await store.upsertBoardRows(board([SMITH]));
  const before = await h.query('SELECT last_changed_at FROM dispatch_board_rows');

  // Somebody inserted a line above. Every row below renumbers and nothing about
  // any of those drivers changed.
  const counts = await store.upsertBoardRows(board([{ ...SMITH, row: 9 }]));
  assert.deepEqual(counts, { inserted: 0, updated: 0, unchanged: 1, skipped: 0 });

  const after = await h.query('SELECT sheet_row, last_changed_at FROM dispatch_board_rows');
  assert.equal(after.rows[0].sheet_row, 9, 'the new position is recorded');
  assert.equal(
    new Date(after.rows[0].last_changed_at).toISOString(),
    new Date(before.rows[0].last_changed_at).toISOString()
  );
});

test('a row that stops appearing is marked absent, never deleted', { skip: skipWithoutPg() }, async (t) => {
  const { h, store } = await setup(t);
  const rows = board([SMITH, { row: 3, driver_name: 'A ONE', truck: '310', status: 'READY' }]);
  await store.upsertBoardRows(rows);

  const absent = await store.markAbsent([rows[0].rowKey]);
  assert.equal(absent, 1);

  const all = await h.query('SELECT row_key, present FROM dispatch_board_rows ORDER BY row_key');
  assert.equal(all.rows.length, 2, '"this driver left the board on Tuesday" is a fact somebody wants');
  assert.equal(all.rows.filter((r) => r.present).length, 1);
});

test('a driver who comes back is the same row, not a second one', { skip: skipWithoutPg() }, async (t) => {
  const { h, store } = await setup(t);
  const rows = board([SMITH]);
  await store.upsertBoardRows(rows);
  await store.markAbsent([]);

  const counts = await store.upsertBoardRows(rows);
  assert.deepEqual(counts, { inserted: 0, updated: 0, unchanged: 1, skipped: 0 });

  const all = await h.query('SELECT COUNT(*)::int AS n, bool_and(present) AS present FROM dispatch_board_rows');
  assert.equal(all.rows[0].n, 1);
  assert.equal(all.rows[0].present, true);
});

test('two people on one truck are two rows', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  await store.upsertBoardRows(board([
    SMITH,
    { row: 3, driver_name: 'JANE DOE (COMPANY DRIVER)', truck: '001', status: 'READY' },
  ]));
  const all = await store.listBoardRows();
  assert.equal(all.length, 2);
});

test('the same truck number in two fleets is two rows', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  await store.upsertBoardRows(board([
    { row: 2, driver_name: 'A ONE (COMPANY DRIVER)', truck: '001', status: 'READY' },
    { row: 3, driver_name: 'B TWO', truck: '001', status: 'READY' },
  ]));
  const summary = await store.summariseBoard();
  assert.equal(summary.present, 2);
  assert.equal(summary.fleet.company, 1);
  assert.equal(summary.fleet.owner_operator, 1);
});

test('the summary is counts, and carries nothing from the board', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  await store.upsertBoardRows(board([SMITH]));
  const summary = await store.summariseBoard();
  assert.equal(summary.present, 1);
  assert.equal(summary.linked, 0);
  const text = JSON.stringify(summary);
  for (const secret of ['JOHN SMITH', '+15555550001', 'T-118', 'Ann']) {
    assert.ok(!text.includes(secret), secret);
  }
});

test('a row with no usable key is skipped rather than written as junk', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { store } = await setup(t);
  const counts = await store.upsertBoardRows([{ driverNameRaw: 'X', rowKey: null }]);
  assert.deepEqual(counts, { inserted: 0, updated: 0, unchanged: 0, skipped: 1 });
  assert.deepEqual(await store.listBoardRows(), []);
});

test('the snapshot reader gives the checks what they need and no phone number', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { store } = await setup(t);
  await store.upsertBoardRows(board([SMITH]));
  const [row] = await store.getBoardRowsForSnapshot();
  assert.equal(row.truckNorm, '001');
  assert.equal(row.fleetType, 'company');
  assert.equal(row.present, true);
  assert.ok(!('phone' in row), 'a check has no use for it');
});

test('the summary groups by whatever status the board actually used', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { store } = await setup(t);
  await store.upsertBoardRows(board([
    { row: 2, driver_name: 'A ONE', truck: '001', status: 'HOME' },
    { row: 3, driver_name: 'B TWO', truck: '002', status: 'HOME' },
    { row: 4, driver_name: 'C THREE', truck: '003', status: 'DISPATCHED' },
    // Not in KNOWN_STATUSES. It must still be COUNTED — a word dispatch
    // invented is exactly what this histogram exists to surface.
    { row: 5, driver_name: 'D FOUR', truck: '004', status: 'PARKED' },
  ]));
  const summary = await store.summariseBoard();
  const byStatus = Object.fromEntries(summary.statuses.map((s) => [s.status, s.count]));
  assert.equal(byStatus.HOME, 2);
  assert.equal(byStatus.DISPATCHED, 1);
  assert.equal(byStatus.PARKED, 1);
  // Ordered by count, so the biggest group is read first.
  assert.equal(summary.statuses[0].status, 'HOME');
});

test('an absent row leaves the status histogram', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  await store.upsertBoardRows(board([
    { row: 2, driver_name: 'A ONE', truck: '001', status: 'HOME' },
    { row: 3, driver_name: 'B TWO', truck: '002', status: 'HOME' },
  ]));
  const rows = await store.listBoardRows();
  await store.markAbsent([rows[0].rowKey]);
  const summary = await store.summariseBoard();
  assert.equal(summary.total, 2);
  assert.equal(summary.present, 1);
  assert.deepEqual(summary.statuses, [{ status: 'HOME', count: 1 }]);
});

// ── Codex review, #214 ───────────────────────────────────────────────────────

test('a row naming a truck and nobody is skipped, not written as a null name', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { store } = await setup(t);
  // `driver_name_raw` is NOT NULL. Before this guard, ONE blank driver cell
  // made every pass fail at the same position, so no later row ever refreshed.
  const counts = await store.upsertBoardRows(board([
    { row: 2, driver_name: 'A ONE (COMPANY DRIVER)', truck: '001' },
    { row: 3, driver_name: '', truck: '002' },
  ]));
  assert.deepEqual(counts, { inserted: 1, updated: 0, unchanged: 0, skipped: 1 });
  const rows = await store.listBoardRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].truckNorm, '001');
});

test('two lines that reduce to one key are stored once and SAY so', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { store } = await setup(t);
  await store.upsertBoardRows(board([
    { row: 2, driver_name: 'A ONE', truck: '001', status: 'HOME' },
    { row: 3, driver_name: 'A ONE', truck: '001', status: 'DISPATCHED' },
  ]));
  const rows = await store.listBoardRows();
  assert.equal(rows.length, 1, 'one key is one row — that is the defect being reported');
  assert.equal(rows[0].keyCollision, true, 'and the row must carry the fact');
  const snapshot = await store.getBoardRowsForSnapshot();
  assert.equal(snapshot[0].keyCollision, true, 'so the check can see it');
});

test('a pass that fails halfway leaves the snapshot exactly as it was', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { store } = await setup(t);
  await store.upsertBoardRows(board([
    { row: 2, driver_name: 'A ONE', truck: '001', status: 'HOME' },
    { row: 3, driver_name: 'B TWO', truck: '002', status: 'HOME' },
  ]));
  const before = await store.listBoardRows();
  assert.equal(before.length, 2);

  const good = board([{ row: 2, driver_name: 'A ONE', truck: '001', status: 'DISPATCHED' }]);
  // A row whose status blows the column's length: the first upsert has already
  // autocommitted by the time this one raises, so without a transaction the
  // snapshot would be left half-new.
  const poison = { ...good[0], rowKey: '003|c three', driverNameRaw: 'C THREE', fleetType: 'nonsense' };
  await assert.rejects(
    () => store.applyBoardPass([...good, poison], ['001|a one']),
    /fleet_type|violates/i
  );

  const after = await store.listBoardRows();
  assert.equal(after.length, 2, 'no row was added');
  assert.equal(after.find((r) => r.truckNorm === '001').status, 'HOME',
    'and the row the pass would have changed is untouched');
  assert.ok(after.every((r) => r.present), 'and nobody was retired');
});

test('a pass that succeeds applies the upserts and the absences together', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { store } = await setup(t);
  await store.upsertBoardRows(board([
    { row: 2, driver_name: 'A ONE', truck: '001' },
    { row: 3, driver_name: 'B TWO', truck: '002' },
  ]));
  const rows = board([{ row: 2, driver_name: 'A ONE', truck: '001', status: 'DISPATCHED' }]);
  const result = await store.applyBoardPass(rows, rows.map((r) => r.rowKey));
  assert.equal(result.updated, 1);
  assert.equal(result.absent, 1);
  const present = await store.listBoardRows({ presentOnly: true });
  assert.equal(present.length, 1);
  assert.equal(present[0].truckNorm, '001');
});

test('the sweep reads the board through the one reader, on the db it was given', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { h, store } = await setup(t);
  await store.upsertBoardRows(board([SMITH]));

  // The sweep's loader must go through `getBoardRowsForSnapshot` rather than
  // repeat the column list: the two copies had already drifted once, and a
  // column the checks rely on going missing is silent.
  const { loadBoardSnapshot } = require('../services/operations/snapshot/loaders');
  const rows = await loadBoardSnapshot({ query: h.query });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].truckNorm, '001');
  assert.equal(rows[0].keyCollision, false);
  assert.ok(!('phone' in rows[0]), 'a check has no use for it');
});
